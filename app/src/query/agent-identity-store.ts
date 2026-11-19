import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
import {
  agentEnrollmentGrant,
  agentIdentity,
  type AgentEnrollmentMode,
} from "@/db/agent-identity-schema";
import {
  oauthAccessToken,
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "@/db/oauth-schema";
import { server } from "@/db/proxy-schema";
import {
  ENROLLMENT_GRANT_TTL_MINUTES,
  generateEnrollmentGrant,
  generateMachineCredential,
  hashEnrollmentGrantSecret,
} from "@/lib/agent-enrollment";
import {
  AGENT_MACHINE_SCOPE,
  AGENT_RESOURCE_NAME,
  AGENT_TOKEN_LIFETIME_SECONDS,
  type OAuthResourceIdentifiers,
} from "@/lib/oauth-provider-config";
import { isUniqueViolation } from "@/lib/pg-error";

/**
 * Enrollment and identity state machine. Every function takes the database
 * explicitly, so the integration tests drive it with a disposable PostgreSQL.
 *
 * Atomicity without interactive transactions (neon-http has none):
 * - Claiming a grant is one conditional UPDATE. Concurrent redemptions cannot
 *   both win: the loser re-evaluates `status = 'issued'` after the winner commits.
 * - Creating the client, its agent-resource link, and the pending identity is one
 *   statement with data-modifying CTEs. It also marks the grant `redeemed`, so
 *   either all of it happens or none does. Its unique indexes reject a second
 *   pending identity for the same server.
 * - Revocation is idempotent and runs in an order that closes access first: the
 *   identity is marked revoked before its client is disabled and its links removed.
 *   A retry after a partial failure completes the remaining steps.
 */

export type EnrollmentRedeemFailure =
  /** Unknown, expired, or revoked grant. Ask an administrator for a fresh grant. */
  | "invalid_grant"
  /** Already redeemed, claimed by another attempt, or the server's identity state refuses this mode. */
  | "grant_unavailable"
  /** The grant's server is disabled. */
  | "server_disabled";

export type EnrollmentRedeemResult =
  | {
      ok: true;
      grantId: string;
      serverId: string;
      identityId: string;
      generation: number;
      clientId: string;
      /** Plaintext. Present only in this successful result. */
      clientSecret: string;
    }
  | { ok: false; reason: EnrollmentRedeemFailure };

export interface CreateEnrollmentGrantInput {
  serverId: string;
  mode: AgentEnrollmentMode;
  capabilities: string[];
  release: string | null;
  createdById: string | null;
  now: Date;
}

export async function createEnrollmentGrant(
  db: Database,
  input: CreateEnrollmentGrantInput,
): Promise<{ grant: EnrollmentGrantView; secret: string }> {
  const [srv] = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.id, input.serverId))
    .limit(1);
  if (!srv) {
    throw new Error("Not found");
  }

  const [active] = await db
    .select({ id: agentIdentity.id })
    .from(agentIdentity)
    .where(
      and(
        eq(agentIdentity.serverId, input.serverId),
        eq(agentIdentity.status, "active"),
      ),
    )
    .limit(1);
  // A stale check: the redemption claim re-checks the same condition atomically.
  if (input.mode === "enroll" && active) {
    throw new Error(
      "Server already has an active agent identity; replace it instead",
    );
  }
  if (input.mode === "replace" && !active) {
    throw new Error("Server has no active agent identity to replace");
  }

  const generated = generateEnrollmentGrant();
  const [row] = await db
    .insert(agentEnrollmentGrant)
    .values({
      id: randomUUID(),
      serverId: input.serverId,
      mode: input.mode,
      tokenHash: generated.tokenHash,
      capabilities: input.capabilities,
      release: input.release,
      expiresAt: new Date(
        input.now.getTime() + ENROLLMENT_GRANT_TTL_MINUTES * 60_000,
      ),
      createdById: input.createdById,
    })
    .returning();
  return { grant: toGrantView(row!), secret: generated.secret };
}

export async function redeemEnrollmentGrant(
  db: Database,
  input: {
    secret: string;
    resources: OAuthResourceIdentifiers;
    now: Date;
  },
): Promise<EnrollmentRedeemResult> {
  const tokenHash = hashEnrollmentGrantSecret(input.secret);
  const { now } = input;
  await ensureAgentResourceRow(db, input.resources.agent);

  const attemptId = randomUUID();
  const claimed = await db
    .update(agentEnrollmentGrant)
    .set({ status: "redeeming", attemptId, claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(agentEnrollmentGrant.tokenHash, tokenHash),
        eq(agentEnrollmentGrant.status, "issued"),
        gt(agentEnrollmentGrant.expiresAt, now),
        sql`EXISTS (SELECT 1 FROM ${server} WHERE ${server.id} = ${agentEnrollmentGrant.serverId} AND ${server.enabled})`,
        // enroll: no active identity may exist. replace: one must.
        sql`(${agentEnrollmentGrant.mode} = 'enroll') = NOT EXISTS (SELECT 1 FROM ${agentIdentity} WHERE ${agentIdentity.serverId} = ${agentEnrollmentGrant.serverId} AND ${agentIdentity.status} = 'active')`,
      ),
    )
    .returning({
      id: agentEnrollmentGrant.id,
      serverId: agentEnrollmentGrant.serverId,
      createdById: agentEnrollmentGrant.createdById,
    });

  const grant = claimed[0];
  if (!grant) {
    return {
      ok: false,
      reason: await diagnoseUnclaimedGrant(db, tokenHash, now),
    };
  }

  const machine = generateMachineCredential();
  const identityId = randomUUID();
  const nowIso = now.toISOString();
  try {
    await db.execute(
      sql`
      WITH client AS (
        INSERT INTO oauth_client (
          id, client_id, client_secret, name, redirect_uris, grant_types,
          client_credentials_scopes, token_endpoint_auth_method, public,
          disabled, created_at, updated_at
        )
        VALUES (
          ${randomUUID()}::text, ${machine.clientId}::text, ${machine.secretHash}::text,
          ${AGENT_RESOURCE_NAME}::text, '[]'::jsonb, '["client_credentials"]'::jsonb,
          ${JSON.stringify([AGENT_MACHINE_SCOPE])}::jsonb, 'client_secret_basic', false,
          false, ${nowIso}::timestamp, ${nowIso}::timestamp
        )
        RETURNING client_id
      ),
      link AS (
        INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
        SELECT ${randomUUID()}::text, client.client_id, ${input.resources.agent}::text, ${nowIso}::timestamp
        FROM client
        RETURNING client_id
      ),
      identity AS (
        INSERT INTO agent_identity (
          id, server_id, generation, oauth_client_id, status, grant_id,
          attempt_id, operator_user_id, created_at, updated_at
        )
        SELECT
          ${identityId}::text,
          ${grant.serverId}::text,
          (SELECT COALESCE(MAX(i.generation), 0) + 1 FROM agent_identity i WHERE i.server_id = ${grant.serverId}::text),
          link.client_id,
          'pending',
          ${grant.id}::text,
          ${attemptId}::text,
          ${grant.createdById}::text,
          ${nowIso}::timestamp,
          ${nowIso}::timestamp
        FROM link
        RETURNING id
      )
      UPDATE agent_enrollment_grant
      SET status = 'redeemed', redeemed_at = ${nowIso}::timestamp, updated_at = ${nowIso}::timestamp
      WHERE id = ${grant.id}::text AND attempt_id = ${attemptId}::text AND status = 'redeeming'
    `,
      "objects",
    );
  } catch (error) {
    if (!isUniqueViolation(error)) {
      // Outcome unknown: the statement may have committed. The grant stays
      // `redeeming`, and an administrator recovers it by revoking the attempt.
      throw error;
    }
    // A unique index refused the identity (another pending identity or a
    // generation clash). Nothing was written, so release the claim.
    await db
      .update(agentEnrollmentGrant)
      .set({
        status: "issued",
        attemptId: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentEnrollmentGrant.id, grant.id),
          eq(agentEnrollmentGrant.attemptId, attemptId),
          eq(agentEnrollmentGrant.status, "redeeming"),
        ),
      );
    return { ok: false, reason: "grant_unavailable" };
  }

  const [created] = await db
    .select({ generation: agentIdentity.generation })
    .from(agentIdentity)
    .where(eq(agentIdentity.id, identityId))
    .limit(1);

  return {
    ok: true,
    grantId: grant.id,
    serverId: grant.serverId,
    identityId,
    generation: created?.generation ?? 0,
    clientId: machine.clientId,
    clientSecret: machine.clientSecret,
  };
}

async function diagnoseUnclaimedGrant(
  db: Database,
  tokenHash: string,
  now: Date,
): Promise<EnrollmentRedeemFailure> {
  const [row] = await db
    .select({
      status: agentEnrollmentGrant.status,
      expiresAt: agentEnrollmentGrant.expiresAt,
      serverId: agentEnrollmentGrant.serverId,
    })
    .from(agentEnrollmentGrant)
    .where(eq(agentEnrollmentGrant.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.status === "revoked") return "invalid_grant";
  if (row.status !== "issued") return "grant_unavailable";
  if (row.expiresAt <= now) return "invalid_grant";
  const [srv] = await db
    .select({ enabled: server.enabled })
    .from(server)
    .where(eq(server.id, row.serverId))
    .limit(1);
  return srv?.enabled ? "grant_unavailable" : "server_disabled";
}

/**
 * Revokes one identity: marks it revoked, disables its OAuth client, and removes
 * its resource links. Idempotent: calling it again finishes any step a previous
 * call did not reach. Revoking a client also revokes its stored access tokens.
 */
export async function revokeAgentIdentity(
  db: Database,
  input: { identityId: string; now: Date },
): Promise<
  { found: false } | { found: true; serverId: string; changed: boolean }
> {
  const [changedRow] = await db
    .update(agentIdentity)
    .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(agentIdentity.id, input.identityId),
        inArray(agentIdentity.status, ["pending", "active"]),
      ),
    )
    .returning({
      identityId: agentIdentity.id,
      serverId: agentIdentity.serverId,
      oauthClientId: agentIdentity.oauthClientId,
    });

  let target = changedRow;
  if (!target) {
    [target] = await db
      .select({
        identityId: agentIdentity.id,
        serverId: agentIdentity.serverId,
        oauthClientId: agentIdentity.oauthClientId,
      })
      .from(agentIdentity)
      .where(eq(agentIdentity.id, input.identityId))
      .limit(1);
  }
  if (!target) return { found: false };

  await db
    .update(oauthClient)
    .set({ disabled: true })
    .where(eq(oauthClient.clientId, target.oauthClientId));
  await db
    .delete(oauthClientResource)
    .where(eq(oauthClientResource.clientId, target.oauthClientId));
  await db
    .update(oauthAccessToken)
    .set({ revoked: input.now })
    .where(
      and(
        eq(oauthAccessToken.clientId, target.oauthClientId),
        isNull(oauthAccessToken.revoked),
      ),
    );

  // End the live session fence when the revoked identity owns it. The socket
  // closes at its next lease check or frame; this makes every durable write
  // fail immediately, even before the socket notices.
  await db
    .update(server)
    .set({
      transportMode: "http",
      wsConnectedAt: null,
      wsSessionId: null,
      wsCredentialKind: null,
      wsCredentialIdentityId: null,
      wsCredentialGeneration: null,
      wsCredentialExpiresAt: null,
    })
    .where(eq(server.wsCredentialIdentityId, target.identityId));

  return {
    found: true,
    serverId: target.serverId,
    changed: changedRow !== undefined,
  };
}

/**
 * Revokes a grant. A grant whose attempt created a still-pending identity (a
 * lost response, or a crash after the redemption) also revokes that identity
 * first, so the orphaned client cannot authenticate. An active identity is left
 * alone: a grant cannot revoke a live identity; use `revokeAgentIdentity`.
 */
export async function revokeEnrollmentGrant(
  db: Database,
  input: { grantId: string; now: Date },
): Promise<
  { found: false } | { found: true; serverId: string; grantStatus: string }
> {
  const [grant] = await db
    .select({
      serverId: agentEnrollmentGrant.serverId,
      status: agentEnrollmentGrant.status,
      attemptId: agentEnrollmentGrant.attemptId,
    })
    .from(agentEnrollmentGrant)
    .where(eq(agentEnrollmentGrant.id, input.grantId))
    .limit(1);
  if (!grant) return { found: false };

  if (
    grant.attemptId &&
    (grant.status === "redeeming" || grant.status === "redeemed")
  ) {
    const orphans = await db
      .select({ id: agentIdentity.id })
      .from(agentIdentity)
      .where(
        and(
          eq(agentIdentity.attemptId, grant.attemptId),
          eq(agentIdentity.status, "pending"),
        ),
      );
    for (const orphan of orphans) {
      await revokeAgentIdentity(db, { identityId: orphan.id, now: input.now });
    }
  }

  if (grant.status !== "revoked") {
    await db
      .update(agentEnrollmentGrant)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(agentEnrollmentGrant.id, input.grantId),
          inArray(agentEnrollmentGrant.status, [
            "issued",
            "redeeming",
            "redeemed",
          ]),
        ),
      );
  }
  return { found: true, serverId: grant.serverId, grantStatus: "revoked" };
}

/** Creates the agent resource row before any link refers to it. Idempotent. */
async function ensureAgentResourceRow(db: Database, identifier: string) {
  await db
    .insert(oauthResource)
    .values({
      id: randomUUID(),
      identifier,
      name: AGENT_RESOURCE_NAME,
      allowedScopes: [AGENT_MACHINE_SCOPE],
      accessTokenTtl: AGENT_TOKEN_LIFETIME_SECONDS,
    })
    .onConflictDoNothing({ target: oauthResource.identifier });
}

export interface EnrollmentGrantView {
  id: string;
  serverId: string;
  mode: AgentEnrollmentMode;
  capabilities: string[];
  release: string | null;
  status: string;
  expiresAt: Date;
  claimedAt: Date | null;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toGrantView(
  row: typeof agentEnrollmentGrant.$inferSelect,
): EnrollmentGrantView {
  return {
    id: row.id,
    serverId: row.serverId,
    mode: row.mode,
    capabilities: row.capabilities,
    release: row.release,
    status: row.status,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
    redeemedAt: row.redeemedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

/** Admin view: never includes the grant hash or attempt identifier. */
export async function listEnrollmentGrants(
  db: Database,
  serverId: string,
): Promise<EnrollmentGrantView[]> {
  const rows = await db
    .select()
    .from(agentEnrollmentGrant)
    .where(eq(agentEnrollmentGrant.serverId, serverId))
    .orderBy(desc(agentEnrollmentGrant.createdAt));
  return rows.map(toGrantView);
}

export interface AgentIdentityView {
  id: string;
  serverId: string;
  generation: number;
  oauthClientId: string;
  status: string;
  grantId: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  revokedAt: Date | null;
}

/** Admin view: the client id is public (it is not a credential). */
export async function listAgentIdentities(
  db: Database,
  serverId: string,
): Promise<AgentIdentityView[]> {
  return db
    .select({
      id: agentIdentity.id,
      serverId: agentIdentity.serverId,
      generation: agentIdentity.generation,
      oauthClientId: agentIdentity.oauthClientId,
      status: agentIdentity.status,
      grantId: agentIdentity.grantId,
      createdAt: agentIdentity.createdAt,
      activatedAt: agentIdentity.activatedAt,
      revokedAt: agentIdentity.revokedAt,
    })
    .from(agentIdentity)
    .where(eq(agentIdentity.serverId, serverId))
    .orderBy(asc(agentIdentity.generation));
}
