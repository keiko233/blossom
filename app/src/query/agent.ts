import type {
  AgentWsConfigAckPayload,
  AgentWsHelloPayload,
  AgentWsUpdateStatuses,
} from "@blossom/contracts/agent-ws";
import type {
  AgentWsV2ConfigAckPayload,
  AgentWsV2HelloPayload,
  AgentWsV2StatusPayload,
} from "@blossom/contracts/agent-ws-v2";
import { parseRevisionSeq } from "@blossom/domain/config-revision";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";

import { type Database, db } from "@/db";
import { agentIdentity } from "@/db/agent-identity-schema";
import { oauthClient } from "@/db/oauth-schema";
import { node, type Server, server } from "@/db/proxy-schema";
import { trafficReport } from "@/db/traffic-schema";
import type { heartbeatSchema } from "@/orpc/proxy/schema";
import { pruneAppliedConfigChanges } from "@/query/config-change";

type AgentHeartbeat = z.infer<typeof heartbeatSchema>;
type DbHandle = Database;

function sanitizeAgentMessage(message: string): string {
  return [...message]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("")
    .replace(/\/tmp\/[^\s:]+/g, "<config>")
    .replace(
      /("[^"]*(?:password|token|secret|private_key)[^"]*"\s*:\s*")[^"]*/gi,
      "$1<redacted>",
    )
    .slice(0, 4096);
}

function updateStatusColumns(
  updates: AgentWsUpdateStatuses | AgentHeartbeat["updates"],
) {
  return {
    ...(updates?.agent
      ? {
          agentUpdateState: updates.agent.state,
          agentUpdateTarget: updates.agent.targetVersion ?? null,
          agentUpdateError: updates.agent.message
            ? sanitizeAgentMessage(updates.agent.message)
            : null,
          agentUpdateCheckedAt: updates.agent.checkedAt
            ? new Date(updates.agent.checkedAt)
            : new Date(),
        }
      : {}),
    ...(updates?.singBox
      ? {
          singBoxUpdateState: updates.singBox.state,
          singBoxUpdateTarget: updates.singBox.targetVersion ?? null,
          singBoxUpdateError: updates.singBox.message
            ? sanitizeAgentMessage(updates.singBox.message)
            : null,
          singBoxUpdateCheckedAt: updates.singBox.checkedAt
            ? new Date(updates.singBox.checkedAt)
            : new Date(),
        }
      : {}),
  };
}

export async function findAgentServerByTokenHash(
  tokenHash: string,
  database: DbHandle = db,
): Promise<Server | null> {
  const [row] = await database
    .select()
    .from(server)
    .where(eq(server.agentTokenHash, tokenHash));
  return row ?? null;
}

export async function findAgentServerById(
  serverId: string,
): Promise<Server | null> {
  const [row] = await db.select().from(server).where(eq(server.id, serverId));
  return row ?? null;
}

export async function listEnabledServerNodes(
  serverId: string,
  database: DbHandle = db,
) {
  return database
    .select()
    .from(node)
    .where(and(eq(node.serverId, serverId), eq(node.enabled, true)))
    .orderBy(asc(node.id));
}

export async function updateAgentHeartbeat(
  serverId: string,
  input: AgentHeartbeat,
): Promise<void> {
  const hasStatus =
    input.runtimeState !== undefined ||
    input.configState !== undefined ||
    input.observedRevision !== undefined ||
    input.appliedRevision !== undefined ||
    input.updates !== undefined ||
    input.error !== undefined ||
    input.clearError !== undefined;
  const error = input.error;
  // The applied revision carries the publish-gate sequence as a numeric
  // prefix ("<seq>:<hash>"). It only ever moves forward; legacy hash-only
  // revisions parse to null and leave the seq untouched.
  const appliedSeq = parseRevisionSeq(input.appliedRevision);

  await db
    .update(server)
    .set({
      lastSeenAt: new Date(),
      ...(input.agentVersion !== undefined
        ? { agentVersion: input.agentVersion }
        : {}),
      ...(input.agentBuildId !== undefined
        ? { agentBuildId: input.agentBuildId }
        : {}),
      ...(input.agentCapabilities !== undefined
        ? { agentCapabilities: input.agentCapabilities }
        : {}),
      ...(input.singBoxVersion !== undefined
        ? { singBoxVersion: input.singBoxVersion }
        : {}),
      ...updateStatusColumns(input.updates),
      ...(input.runtimeState !== undefined
        ? { runtimeState: input.runtimeState }
        : {}),
      ...(input.configState !== undefined
        ? { configState: input.configState }
        : {}),
      ...(input.observedRevision !== undefined
        ? { observedRevision: input.observedRevision }
        : {}),
      ...(input.appliedRevision !== undefined
        ? { appliedRevision: input.appliedRevision }
        : {}),
      ...(appliedSeq !== null
        ? {
            appliedRevisionSeq: sql<number>`GREATEST(${server.appliedRevisionSeq}, ${appliedSeq})`,
          }
        : {}),
      ...(input.clearActiveNodeIds
        ? { activeNodeIds: [] }
        : input.activeNodeIds !== undefined
          ? { activeNodeIds: input.activeNodeIds }
          : {}),
      ...(hasStatus ? { statusReportedAt: new Date() } : {}),
      ...(!hasStatus
        ? {
            runtimeState: "unknown" as const,
            configState: "unknown" as const,
            activeNodeIds: [],
            statusReportedAt: null,
            lastErrorPhase: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorNodeId: null,
            lastErrorAt: null,
          }
        : {}),
      ...(input.appliedAt !== undefined
        ? { lastAppliedAt: new Date(input.appliedAt) }
        : {}),
      ...(input.clearError
        ? {
            lastErrorPhase: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorNodeId: null,
            lastErrorAt: null,
          }
        : error === undefined
          ? {}
          : {
              lastErrorPhase: error.phase,
              lastErrorCode: error.code,
              lastErrorMessage: sanitizeAgentMessage(error.message),
              lastErrorNodeId: error.nodeId ?? null,
              lastErrorAt: error.occurredAt
                ? new Date(error.occurredAt)
                : new Date(),
            }),
    })
    .where(eq(server.id, serverId));

  // Change links at or below the confirmed applied seq can never gate again.
  if (appliedSeq !== null) {
    await pruneAppliedConfigChanges(serverId, appliedSeq);
  }
}

export interface AgentWsSessionStart {
  /** Connection identity for v1 disconnect clearing and PTY relay routing. */
  connectedAt: Date;
  /** Fence for every durable write made by this session (v1 and v2). */
  sessionId: string;
}

export type AgentSessionCredential =
  | {
      kind: "static";
      /** SHA-256 of the bearer token that authenticated the upgrade. */
      tokenHash: string;
    }
  | {
      kind: "oauth";
      identityId: string;
      generation: number;
      /** Provider client id. Kept for diagnostics; never a secret. */
      clientId: string;
      /** Epoch seconds from the verified machine token's `exp`. */
      expiresAt: number;
      identityStatus: "pending" | "active";
    };

export interface AgentWsV2SessionStart extends AgentWsSessionStart {
  /**
   * A pending identity may only prove itself with `hello`; until promotion it
   * does not own the server's session fence.
   */
  pending: boolean;
  /** Lease deadline from the machine token, or `null` for a static token. */
  expiresAt: number | null;
  credential: AgentSessionCredential;
}

/**
 * Starts a WebSocket session and makes it the server's current one in a
 * single UPDATE. A newer handshake therefore replaces an older session's
 * marker atomically; the older session's later writes match nothing.
 */
export async function startAgentWsSession(
  serverId: string,
  database: DbHandle = db,
): Promise<AgentWsSessionStart> {
  const connectedAt = new Date();
  const sessionId = randomUUID();
  await database
    .update(server)
    .set({
      lastSeenAt: connectedAt,
      transportMode: "ws",
      wsConnectedAt: connectedAt,
      wsSessionId: sessionId,
      wsCredentialKind: "static",
      wsCredentialIdentityId: null,
      wsCredentialGeneration: null,
      wsCredentialExpiresAt: null,
      wsPendingSessionId: null,
      wsPendingIdentityId: null,
      wsPendingGeneration: null,
      wsPendingExpiresAt: null,
    })
    .where(eq(server.id, serverId));
  return { connectedAt, sessionId };
}

/**
 * The credential half of every v2 session fence. A session started with a
 * static token keeps today's token-hash rotation semantics: the session id is
 * cleared in the same statement that replaces the hash. An OAuth session is
 * additionally bound to the active identity generation and the machine token
 * expiry, so revocation, supersession, or expiry makes every fenced read and
 * write match nothing even while the socket is still open.
 */
function currentAgentCredentialSql() {
  return sql`(
    (
      (
        ${server.wsCredentialKind} IS NULL
        OR ${server.wsCredentialKind} = 'static'
      )
      AND ${server.agentTokenHash} IS NOT NULL
    )
    OR (
      ${server.wsCredentialKind} = 'oauth'
      AND ${server.wsCredentialExpiresAt} > timezone('utc', now())
      AND EXISTS (
        SELECT 1
        FROM agent_identity ai
        JOIN oauth_client oc ON oc.client_id = ai.oauth_client_id
        WHERE ai.id = ${server.wsCredentialIdentityId}
          AND ai.server_id = ${server.id}
          AND ai.generation = ${server.wsCredentialGeneration}
          AND ai.status = 'active'
          AND oc.disabled = false
          AND EXISTS (
            SELECT 1 FROM oauth_client_resource r
            WHERE r.client_id = oc.client_id
          )
      )
    )
  )`;
}

/** Fences a write to `serverId`/`sessionId`, including the credential state. */
export function currentAgentSessionFenceSql(
  serverId: string,
  sessionId: string,
) {
  return sql`EXISTS (
    SELECT 1 FROM server
    WHERE ${server.id} = ${serverId}::text
      AND ${server.wsSessionId} = ${sessionId}::text
      AND ${currentAgentCredentialSql()}
  )`;
}

function usableOauthIdentitySql(
  serverId: string,
  credential: Extract<AgentSessionCredential, { kind: "oauth" }>,
  statuses: readonly ("pending" | "active")[],
) {
  const statusList = sql.raw(
    statuses.map((status) => `'${status}'`).join(", "),
  );
  return sql`EXISTS (
    SELECT 1
    FROM agent_identity ai
    JOIN oauth_client oc ON oc.client_id = ai.oauth_client_id
    JOIN server s ON s.id = ai.server_id
    WHERE ai.id = ${credential.identityId}::text
      AND ai.server_id = ${serverId}::text
      AND ai.generation = ${credential.generation}::integer
      AND ai.status IN (${statusList})
      AND oc.disabled = false
      AND s.enabled = true
      AND EXISTS (
        SELECT 1 FROM oauth_client_resource r
        WHERE r.client_id = oc.client_id
      )
  )`;
}

function oauthSessionColumns(
  connectedAt: Date,
  sessionId: string,
  credential: Extract<AgentSessionCredential, { kind: "oauth" }>,
) {
  return {
    lastSeenAt: connectedAt,
    transportMode: "ws" as const,
    wsConnectedAt: connectedAt,
    wsSessionId: sessionId,
    wsCredentialKind: "oauth" as const,
    wsCredentialIdentityId: credential.identityId,
    wsCredentialGeneration: credential.generation,
    wsCredentialExpiresAt: new Date(credential.expiresAt * 1000),
    wsPendingSessionId: null,
    wsPendingIdentityId: null,
    wsPendingGeneration: null,
    wsPendingExpiresAt: null,
  };
}

/**
 * Starts a v2 session only if the credential that authenticated the upgrade is
 * still current. A static token is conditional on its unchanged hash. An active
 * OAuth identity takes the fence immediately. A pending identity gets a
 * proof-only session: it does not displace the live session until its `hello`
 * is accepted by {@link promoteAgentV2WsSession}.
 */
export async function startAgentV2WsSession(
  serverId: string,
  credential: AgentSessionCredential,
  database: DbHandle = db,
): Promise<AgentWsV2SessionStart | null> {
  const connectedAt = new Date();
  const sessionId = randomUUID();
  if (credential.kind === "static") {
    const rows = await database
      .update(server)
      .set({
        lastSeenAt: connectedAt,
        transportMode: "ws",
        wsConnectedAt: connectedAt,
        wsSessionId: sessionId,
        wsCredentialKind: "static",
        wsCredentialIdentityId: null,
        wsCredentialGeneration: null,
        wsCredentialExpiresAt: null,
        wsPendingSessionId: null,
        wsPendingIdentityId: null,
        wsPendingGeneration: null,
        wsPendingExpiresAt: null,
      })
      .where(
        and(
          eq(server.id, serverId),
          eq(server.agentTokenHash, credential.tokenHash),
          eq(server.enabled, true),
        ),
      )
      .returning({ id: server.id });
    return rows.length > 0
      ? {
          connectedAt,
          sessionId,
          pending: false,
          expiresAt: null,
          credential,
        }
      : null;
  }

  if (credential.expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  const [identity] = await database
    .select({
      status: agentIdentity.status,
      generation: agentIdentity.generation,
    })
    .from(agentIdentity)
    .innerJoin(
      oauthClient,
      eq(oauthClient.clientId, agentIdentity.oauthClientId),
    )
    .innerJoin(server, eq(server.id, agentIdentity.serverId))
    .where(
      and(
        eq(agentIdentity.id, credential.identityId),
        eq(agentIdentity.serverId, serverId),
        eq(agentIdentity.generation, credential.generation),
        inArray(agentIdentity.status, ["pending", "active"]),
        eq(oauthClient.disabled, false),
        eq(server.enabled, true),
        sql`EXISTS (
          SELECT 1 FROM oauth_client_resource r
          WHERE r.client_id = ${oauthClient.clientId}
        )`,
      ),
    )
    .limit(1);
  if (!identity) {
    return null;
  }

  if (identity.status === "pending") {
    const proof = await database
      .update(server)
      .set({
        wsPendingSessionId: sessionId,
        wsPendingIdentityId: credential.identityId,
        wsPendingGeneration: credential.generation,
        wsPendingExpiresAt: new Date(credential.expiresAt * 1000),
      })
      .where(
        and(
          eq(server.id, serverId),
          eq(server.enabled, true),
          usableOauthIdentitySql(serverId, credential, ["pending"]),
        ),
      )
      .returning({ id: server.id });
    if (proof.length === 0) {
      return null;
    }
    return {
      connectedAt,
      sessionId,
      pending: true,
      expiresAt: credential.expiresAt,
      credential: { ...credential, identityStatus: "pending" },
    };
  }

  const rows = await database
    .update(server)
    .set(oauthSessionColumns(connectedAt, sessionId, credential))
    .where(
      and(
        eq(server.id, serverId),
        eq(server.enabled, true),
        usableOauthIdentitySql(serverId, credential, ["active"]),
      ),
    )
    .returning({ id: server.id });
  return rows.length > 0
    ? {
        connectedAt,
        sessionId,
        pending: false,
        expiresAt: credential.expiresAt,
        credential: { ...credential, identityStatus: "active" },
      }
    : null;
}

/**
 * Promotes a pending OAuth identity after its `hello` proved the connection,
 * and moves the active fence to that exact socket. The proof lane, the identity
 * transition, and the server fence are one statement: either the pending
 * generation becomes active and owns the lane, or nothing changes and the old
 * active identity and session remain usable. The demote and promote are one
 * row-set UPDATE, so the partial unique active index stays satisfied and the
 * statement is safe on neon-http's non-interactive driver.
 */
export async function promoteAgentV2WsSession(
  serverId: string,
  sessionId: string,
  credential: AgentSessionCredential,
  database: DbHandle = db,
): Promise<Server | null> {
  if (credential.kind !== "oauth") {
    return null;
  }
  if (credential.expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  const rows = await database.execute<{ id: string }>(
    sql`
      WITH proof AS MATERIALIZED (
        SELECT s.id AS server_id, a.id AS identity_id, a.generation
        FROM server s
        JOIN agent_identity a ON a.server_id = s.id
        JOIN oauth_client oc ON oc.client_id = a.oauth_client_id
        WHERE s.id = ${serverId}::text
          AND s.enabled = true
          AND s.ws_pending_session_id = ${sessionId}::text
          AND s.ws_pending_identity_id = ${credential.identityId}::text
          AND s.ws_pending_generation = ${credential.generation}::integer
          AND s.ws_pending_expires_at > timezone('utc', now())
          AND a.id = ${credential.identityId}::text
          AND a.generation = ${credential.generation}::integer
          AND a.status = 'pending'
          AND oc.disabled = false
          AND EXISTS (
            SELECT 1 FROM oauth_client_resource r
            WHERE r.client_id = oc.client_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_identity newer
            WHERE newer.server_id = s.id
              AND newer.generation > a.generation
              AND newer.status IN ('pending', 'active')
          )
        FOR UPDATE OF s, a
      ),
      transition AS (
        UPDATE agent_identity a
        SET status = CASE
              WHEN a.id = ${credential.identityId}::text THEN 'active'
              ELSE 'superseded'
            END,
            activated_at = CASE
              WHEN a.id = ${credential.identityId}::text
                THEN timezone('utc', now())
              ELSE a.activated_at
            END,
            updated_at = timezone('utc', now())
        WHERE a.server_id = ${serverId}::text
          AND EXISTS (SELECT 1 FROM proof)
          AND (
            (
              a.id = ${credential.identityId}::text
              AND a.status = 'pending'
            )
            OR (
              a.status = 'active'
              AND a.id <> ${credential.identityId}::text
              AND a.generation < ${credential.generation}::integer
            )
          )
        RETURNING a.id, a.status
      ),
      fence AS (
        UPDATE server s
        SET last_seen_at = timezone('utc', now()),
            transport_mode = 'ws',
            ws_connected_at = timezone('utc', now()),
            ws_session_id = ${sessionId}::text,
            ws_credential_kind = 'oauth',
            ws_credential_identity_id = ${credential.identityId}::text,
            ws_credential_generation = ${credential.generation}::integer,
            ws_credential_expires_at = to_timestamp(${credential.expiresAt}),
            ws_pending_session_id = NULL,
            ws_pending_identity_id = NULL,
            ws_pending_generation = NULL,
            ws_pending_expires_at = NULL,
            updated_at = timezone('utc', now())
        WHERE s.id = ${serverId}::text
          AND EXISTS (SELECT 1 FROM proof)
          AND EXISTS (
            SELECT 1 FROM transition
            WHERE id = ${credential.identityId}::text
              AND status = 'active'
          )
        RETURNING s.id
      )
      SELECT id FROM fence
    `,
    "objects",
  );
  if (rows.length === 0) {
    return null;
  }
  return loadCurrentAgentServer(serverId, sessionId, database);
}

/**
 * Whether this exact pending proof lane still holds an unexpired usable
 * identity. A newer handshake for the same pending identity overwrites the
 * proof columns, so the older socket fails its lease check.
 */
export async function revalidatePendingAgentV2Session(
  serverId: string,
  sessionId: string,
  credential: AgentSessionCredential,
  database: DbHandle = db,
): Promise<boolean> {
  if (credential.kind !== "oauth") {
    return false;
  }
  if (credential.expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const [row] = await database
    .select({ id: server.id })
    .from(server)
    .innerJoin(agentIdentity, eq(agentIdentity.serverId, server.id))
    .innerJoin(
      oauthClient,
      eq(oauthClient.clientId, agentIdentity.oauthClientId),
    )
    .where(
      and(
        eq(server.id, serverId),
        eq(server.enabled, true),
        eq(server.wsPendingSessionId, sessionId),
        eq(server.wsPendingIdentityId, credential.identityId),
        eq(server.wsPendingGeneration, credential.generation),
        gt(server.wsPendingExpiresAt, new Date()),
        eq(agentIdentity.id, credential.identityId),
        eq(agentIdentity.generation, credential.generation),
        eq(agentIdentity.status, "pending"),
        eq(oauthClient.disabled, false),
        sql`EXISTS (
          SELECT 1 FROM oauth_client_resource r
          WHERE r.client_id = ${oauthClient.clientId}
        )`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Records a completed WebSocket handshake without touching agent-reported
 * status columns. The returned timestamp is the connection identity used to
 * clear `transportMode` only when this exact socket closes.
 */
export async function markAgentWsConnected(
  serverId: string,
  database: DbHandle = db,
): Promise<Date> {
  return (await startAgentWsSession(serverId, database)).connectedAt;
}

/** Clears only the handshake that is still current; a reconnect wins races. */
export async function markAgentWsDisconnected(
  serverId: string,
  connectedAt: Date,
  database: DbHandle = db,
): Promise<void> {
  await database
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
    .where(and(eq(server.id, serverId), eq(server.wsConnectedAt, connectedAt)));
}

/**
 * Ends a v2 session by its fence. A session that was already replaced matches
 * no row and leaves the newer session's marker untouched.
 */
export async function endAgentWsSession(
  serverId: string,
  sessionId: string,
  database: DbHandle = db,
): Promise<void> {
  await database.execute(
    sql`
      UPDATE server
      SET transport_mode = CASE
            WHEN ws_session_id = ${sessionId}::text THEN 'http'
            ELSE transport_mode
          END,
          ws_connected_at = CASE
            WHEN ws_session_id = ${sessionId}::text THEN NULL
            ELSE ws_connected_at
          END,
          ws_session_id = CASE
            WHEN ws_session_id = ${sessionId}::text THEN NULL
            ELSE ws_session_id
          END,
          ws_credential_kind = CASE
            WHEN ws_session_id = ${sessionId}::text THEN NULL
            ELSE ws_credential_kind
          END,
          ws_credential_identity_id = CASE
            WHEN ws_session_id = ${sessionId}::text THEN NULL
            ELSE ws_credential_identity_id
          END,
          ws_credential_generation = CASE
            WHEN ws_session_id = ${sessionId}::text THEN NULL
            ELSE ws_credential_generation
          END,
          ws_credential_expires_at = CASE
            WHEN ws_session_id = ${sessionId}::text THEN NULL
            ELSE ws_credential_expires_at
          END,
          ws_pending_session_id = CASE
            WHEN ws_pending_session_id = ${sessionId}::text THEN NULL
            ELSE ws_pending_session_id
          END,
          ws_pending_identity_id = CASE
            WHEN ws_pending_session_id = ${sessionId}::text THEN NULL
            ELSE ws_pending_identity_id
          END,
          ws_pending_generation = CASE
            WHEN ws_pending_session_id = ${sessionId}::text THEN NULL
            ELSE ws_pending_generation
          END,
          ws_pending_expires_at = CASE
            WHEN ws_pending_session_id = ${sessionId}::text THEN NULL
            ELSE ws_pending_expires_at
          END,
          updated_at = timezone('utc', now())
      WHERE id = ${serverId}::text
        AND (
          ws_session_id = ${sessionId}::text
          OR ws_pending_session_id = ${sessionId}::text
        )
    `,
    "objects",
  );
}

/**
 * Applies hello metadata independently of the heartbeat's status reset rules.
 * Only fields present in the frame are written; `runtimeState`, active nodes
 * and unrelated error state stay as the last HTTP heartbeat reported them.
 */
export async function recordAgentHello(
  serverId: string,
  hello: AgentWsHelloPayload,
  database: DbHandle = db,
): Promise<void> {
  const appliedSeq = parseRevisionSeq(hello.appliedRevision);
  await database
    .update(server)
    .set({
      lastSeenAt: new Date(),
      ...(hello.agentVersion !== undefined
        ? { agentVersion: hello.agentVersion }
        : {}),
      ...(hello.agentBuildId !== undefined
        ? { agentBuildId: hello.agentBuildId }
        : {}),
      agentCapabilities: hello.capabilities,
      ...(hello.appliedRevision !== undefined
        ? { appliedRevision: hello.appliedRevision }
        : {}),
      ...(appliedSeq !== null
        ? {
            appliedRevisionSeq: sql<number>`GREATEST(${server.appliedRevisionSeq}, ${appliedSeq})`,
          }
        : {}),
      ...(hello.updates ? updateStatusColumns(hello.updates) : {}),
      ...(hello.updates ? { statusReportedAt: new Date() } : {}),
    })
    .where(eq(server.id, serverId));

  if (appliedSeq !== null) {
    await pruneAppliedConfigChanges(serverId, appliedSeq, database);
  }
}

/**
 * Applies a push-channel config acknowledgement. An empty applied revision on
 * failure is preserved as-is but does not move the publish-gate sequence.
 */
export async function recordAgentConfigAck(
  serverId: string,
  ack: AgentWsConfigAckPayload,
  database: DbHandle = db,
): Promise<void> {
  const appliedSeq = parseRevisionSeq(ack.appliedRevision);
  const now = new Date();
  const succeeded = ack.error === undefined;
  await database
    .update(server)
    .set({
      lastSeenAt: now,
      statusReportedAt: now,
      configState: succeeded ? "applied" : "apply_failed",
      ...(ack.appliedRevision.length > 0
        ? { appliedRevision: ack.appliedRevision }
        : {}),
      ...(appliedSeq !== null
        ? {
            appliedRevisionSeq: sql<number>`GREATEST(${server.appliedRevisionSeq}, ${appliedSeq})`,
          }
        : {}),
      ...(succeeded && ack.appliedRevision.length > 0
        ? { lastAppliedAt: now }
        : {}),
      ...(ack.error
        ? {
            lastErrorPhase: "config",
            lastErrorCode: "config_ack",
            lastErrorMessage: sanitizeAgentMessage(ack.error),
            lastErrorNodeId: null,
            lastErrorAt: now,
          }
        : {}),
    })
    .where(eq(server.id, serverId));

  if (appliedSeq !== null) {
    await pruneAppliedConfigChanges(serverId, appliedSeq, database);
  }
}

export async function recordAgentUpdateStatus(
  serverId: string,
  updates: AgentWsUpdateStatuses,
  database: DbHandle = db,
): Promise<void> {
  await database
    .update(server)
    .set({
      lastSeenAt: new Date(),
      statusReportedAt: new Date(),
      ...updateStatusColumns(updates),
    })
    .where(eq(server.id, serverId));
}

export async function listServerNodeIds(
  serverId: string,
  database: DbHandle = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: node.id })
    .from(node)
    .where(eq(node.serverId, serverId));
  return rows.map((row) => row.id);
}

/**
 * Loads the server row for a v2 session, but only while that session is still
 * current. A replaced session, or one whose credential was rotated (which
 * clears the marker), gets `null` and must not read or send configuration.
 */
export async function loadCurrentAgentServer(
  serverId: string,
  sessionId: string,
  database: DbHandle = db,
): Promise<Server | null> {
  const [row] = await database
    .select()
    .from(server)
    .where(currentSession(serverId, sessionId));
  return row ?? null;
}

/** The predicate every v2 session write carries: this session is current. */
function currentSession(serverId: string, sessionId: string) {
  return and(
    eq(server.id, serverId),
    eq(server.wsSessionId, sessionId),
    currentAgentCredentialSql(),
  );
}

/**
 * The applied-revision columns for a revision the agent reports. The string
 * follows the sequence: it changes only when the report is at least as new as
 * what is already recorded, so an older report never rewinds the gate.
 */
function appliedRevisionColumns(revision: string, seq: number) {
  return {
    appliedRevision: sql<string>`CASE WHEN ${server.appliedRevisionSeq} <= ${seq}::integer THEN ${revision}::text ELSE ${server.appliedRevision} END`,
    appliedRevisionSeq: sql<number>`GREATEST(${server.appliedRevisionSeq}, ${seq}::integer)`,
  };
}

/**
 * Records a v2 `hello` for the current session. Returns the server row, or
 * `null` when the session has been replaced so the caller must stop.
 */
export async function recordAgentV2Hello(
  serverId: string,
  sessionId: string,
  hello: AgentWsV2HelloPayload,
  database: DbHandle = db,
): Promise<Server | null> {
  const now = new Date();
  const applied = hello.applied;
  const [row] = await database
    .update(server)
    .set({
      lastSeenAt: now,
      agentVersion: hello.agentVersion,
      agentBuildId: hello.agentBuildId,
      agentCapabilities: hello.capabilities,
      ...(applied
        ? appliedRevisionColumns(
            applied.desiredRevision,
            applied.desiredRevisionSeq,
          )
        : {}),
      ...(hello.updates
        ? { ...updateStatusColumns(hello.updates), statusReportedAt: now }
        : {}),
    })
    .where(currentSession(serverId, sessionId))
    .returning();
  if (row && applied) {
    await pruneAppliedConfigChanges(
      serverId,
      applied.desiredRevisionSeq,
      database,
    );
  }
  return row ?? null;
}

/**
 * Records a v2 `agent.status` for the current session. Only fields the agent
 * sent change; `error: null` clears the last error. Returns the updated row
 * (carrying the authoritative identifiers), or `null` when the session is
 * no longer current.
 */
export async function recordAgentV2Status(
  serverId: string,
  sessionId: string,
  status: AgentWsV2StatusPayload,
  database: DbHandle = db,
): Promise<Server | null> {
  const now = new Date();
  const error = status.error;
  const [row] = await database
    .update(server)
    .set({
      lastSeenAt: now,
      statusReportedAt: now,
      ...(status.runtimeState ? { runtimeState: status.runtimeState } : {}),
      ...(status.configState ? { configState: status.configState } : {}),
      ...(status.singBoxVersion
        ? { singBoxVersion: status.singBoxVersion }
        : {}),
      ...(status.activeNodeIds ? { activeNodeIds: status.activeNodeIds } : {}),
      ...(status.updates ? updateStatusColumns(status.updates) : {}),
      ...(error === undefined
        ? {}
        : error === null
          ? {
              lastErrorPhase: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              lastErrorNodeId: null,
              lastErrorAt: null,
            }
          : {
              lastErrorPhase: error.phase,
              lastErrorCode: error.code,
              lastErrorMessage: sanitizeAgentMessage(error.message),
              lastErrorNodeId: error.nodeId ?? null,
              lastErrorAt: error.occurredAt ? new Date(error.occurredAt) : now,
            }),
    })
    .where(currentSession(serverId, sessionId))
    .returning();
  return row ?? null;
}

/**
 * Records a v2 `config.ack`. A success advances the applied revision in the
 * same statement that checks the session fence, and only when the acknowledged
 * sequence is not older than the recorded one. A stale or replayed success
 * therefore cannot reopen or rewind the publish gate. A failure records the
 * failed stage and leaves the applied revision untouched.
 */
export async function recordAgentV2ConfigAck(
  serverId: string,
  sessionId: string,
  ack: AgentWsV2ConfigAckPayload,
  database: DbHandle = db,
): Promise<"replaced" | "applied" | "failed" | "stale"> {
  const now = new Date();
  if (ack.outcome === "failed") {
    const rows = await database
      .update(server)
      .set({
        lastSeenAt: now,
        statusReportedAt: now,
        configState: "apply_failed",
        lastErrorPhase: "config",
        lastErrorCode: `config_${ack.stage ?? "unknown"}`,
        lastErrorMessage: sanitizeAgentMessage(ack.error ?? "config failed"),
        lastErrorNodeId: null,
        lastErrorAt: now,
      })
      .where(currentSession(serverId, sessionId))
      .returning({ id: server.id });
    return rows.length > 0 ? "failed" : "replaced";
  }

  const seq = ack.desired.desiredRevisionSeq;
  const [outcome] = await database.execute<{ fenced: number; applied: number }>(
    sql`
      WITH fenced AS (
        SELECT 1 FROM server
        WHERE id = ${serverId}::text
          AND ws_session_id = ${sessionId}::text
          AND ${currentAgentCredentialSql()}
        FOR SHARE
      ),
      advanced AS (
        UPDATE server SET
          applied_revision = ${ack.desired.desiredRevision}::text,
          applied_revision_seq = ${seq}::integer,
          config_state = 'applied',
          last_applied_at = timezone('utc', now()),
          last_seen_at = timezone('utc', now()),
          status_reported_at = timezone('utc', now())
        WHERE id = ${serverId}::text
          AND EXISTS (SELECT 1 FROM fenced)
          AND applied_revision_seq <= ${seq}::integer
          AND desired_revision_seq >= ${seq}::integer
        RETURNING id
      )
      SELECT (SELECT count(*) FROM fenced)::int AS fenced,
             (SELECT count(*) FROM advanced)::int AS applied
    `,
    "objects",
  );
  if (!outcome || Number(outcome.fenced) === 0) {
    return "replaced";
  }
  if (Number(outcome.applied) === 0) {
    return "stale";
  }
  await pruneAppliedConfigChanges(serverId, seq, database);
  return "applied";
}

/**
 * A configuration identifier compiled from the state read before the compile.
 * `desiredInputsVersion` is the version the server row carried at that read.
 */
export interface CachedDesiredRevision {
  desiredRevisionSeq: number;
  desiredInputsVersion: number;
  desiredRevision: string;
  /** The identifier may be trusted without recompiling only until this. */
  validUntil: Date;
}

/**
 * Stores the identifier compiled for the current session. The write names the
 * sequence and inputs version it was compiled from and matches only while both
 * are unchanged. A compile that raced a publish-gate change or an invalidation,
 * including one on another instance, therefore cannot cache a stale identifier.
 */
export async function cacheAgentDesiredRevision(
  serverId: string,
  sessionId: string,
  cache: CachedDesiredRevision,
  database: DbHandle = db,
): Promise<void> {
  await database
    .update(server)
    .set({
      desiredConfigRevision: cache.desiredRevision,
      desiredConfigValidUntil: cache.validUntil,
    })
    .where(
      and(
        currentSession(serverId, sessionId),
        eq(server.desiredRevisionSeq, cache.desiredRevisionSeq),
        eq(server.desiredInputsVersion, cache.desiredInputsVersion),
      ),
    );
}

/**
 * Discards cached configuration identifiers and bumps their inputs version, so
 * the next v2 status, hello or snapshot recompiles, and a compile that began
 * before this call cannot store its identifier. Call it after any mutation of
 * compiled inputs that no publish-gate record covers (routing rules,
 * certificates, traffic quota), and after a change notification, which may not
 * be delivered. Omit `serverIds` to invalidate every server.
 */
export async function invalidateDesiredConfigRevisions(
  serverIds?: readonly string[],
  database: DbHandle = db,
): Promise<void> {
  if (serverIds && serverIds.length === 0) {
    return;
  }
  await database
    .update(server)
    .set({
      desiredConfigRevision: null,
      desiredConfigValidUntil: null,
      desiredInputsVersion: sql`${server.desiredInputsVersion} + 1`,
    })
    .where(serverIds ? inArray(server.id, [...serverIds]) : undefined);
}

/**
 * Invalidates after a mutation has already committed, so a failure here cannot
 * fail the caller's operation. A missed invalidation is still bounded by the
 * cached identifier's deadline.
 */
export async function invalidateDesiredConfigRevisionsAfterCommit(
  serverIds?: readonly string[],
  database: DbHandle = db,
): Promise<void> {
  try {
    await invalidateDesiredConfigRevisions(serverIds, database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent desired configuration invalidation failed: ${message}`);
  }
}

/** Ends only a current static session, leaving an active OAuth fence intact. */
function clearStaticSessionAssignmentsSql() {
  const isStatic = sql`${server.wsCredentialKind} IS NULL OR ${server.wsCredentialKind} = 'static'`;
  return sql`
    transport_mode = CASE WHEN ${isStatic} THEN 'http' ELSE ${server.transportMode} END,
    ws_connected_at = CASE WHEN ${isStatic} THEN NULL ELSE ${server.wsConnectedAt} END,
    ws_session_id = CASE WHEN ${isStatic} THEN NULL ELSE ${server.wsSessionId} END,
    ws_credential_kind = CASE WHEN ${isStatic} THEN NULL ELSE ${server.wsCredentialKind} END,
    ws_credential_identity_id = CASE WHEN ${isStatic} THEN NULL ELSE ${server.wsCredentialIdentityId} END,
    ws_credential_generation = CASE WHEN ${isStatic} THEN NULL ELSE ${server.wsCredentialGeneration} END,
    ws_credential_expires_at = CASE WHEN ${isStatic} THEN NULL ELSE ${server.wsCredentialExpiresAt} END
  `;
}

/**
 * Enables a static backup credential only when the server has none. Existing
 * OAuth or static sessions are untouched: there was no static credential to
 * invalidate.
 */
export async function enableAgentBackupCredential(
  serverId: string,
  credential: { hash: string; prefix: string },
  database: DbHandle = db,
): Promise<{ id: string } | null> {
  const rows = await database.execute<{ id: string }>(
    sql`
      UPDATE server
      SET agent_token_hash = ${credential.hash},
          agent_token_prefix = ${credential.prefix},
          updated_at = timezone('utc', now())
      WHERE id = ${serverId}::text
        AND agent_token_hash IS NULL
      RETURNING id
    `,
    "objects",
  );
  return rows[0] ?? null;
}

/**
 * Disables the static backup credential and ends an existing static session in
 * the same statement. An active OAuth session, and any pending OAuth proof, is
 * left untouched.
 */
export async function disableAgentBackupCredential(
  serverId: string,
  database: DbHandle = db,
): Promise<{ id: string } | null> {
  const rows = await database.execute<{ id: string }>(
    sql`
      UPDATE server
      SET agent_token_hash = NULL,
          agent_token_prefix = NULL,
          ${clearStaticSessionAssignmentsSql()},
          updated_at = timezone('utc', now())
      WHERE id = ${serverId}::text
      RETURNING id
    `,
    "objects",
  );
  return rows[0] ?? null;
}

/**
 * Replaces (or first enables) a server's static backup credential and ends its
 * current static v2 session in the same statement. The old session's fenced
 * writes then match no row and its configuration reads fail, so it stops at
 * its next frame; a reconnect with the old credential is refused at upgrade.
 * An active OAuth session is not displaced.
 */
export async function rotateAgentCredential(
  serverId: string,
  credential: { hash: string; prefix: string },
  database: DbHandle = db,
): Promise<{ id: string } | null> {
  const rows = await database.execute<{ id: string }>(
    sql`
      UPDATE server
      SET agent_token_hash = ${credential.hash},
          agent_token_prefix = ${credential.prefix},
          ${clearStaticSessionAssignmentsSql()},
          updated_at = timezone('utc', now())
      WHERE id = ${serverId}::text
      RETURNING id
    `,
    "objects",
  );
  return rows[0] ?? null;
}

/**
 * How long a `(serverId, reportId)` ledger row is kept. It must stay longer than
 * the longest time an agent may keep retrying one batch (7 days, enforced by the
 * agent), otherwise a very late replay could find no ledger row and be applied
 * a second time.
 */
export const TRAFFIC_REPORT_RETENTION_DAYS = 30;
const TRAFFIC_REPORT_PRUNE_BATCH = 500;

/** One resolved entry of a traffic report, ready to be applied. */
export interface TrafficReportRow {
  subscriptionId: string;
  nodeId: string | null;
  uplinkBytes: number;
  downlinkBytes: number;
}

export interface RecordTrafficReport {
  serverId: string;
  /** Absent for legacy agents; present reports are applied at most once. */
  reportId?: string;
  /** Required with `reportId`; see {@link computeTrafficReportHash}. */
  contentHash?: string;
  /** Connection to write through; defaults to the shared database facade. */
  database?: DbHandle;
  /**
   * WebSocket v2 session fence. When set, the report is applied only if this
   * session is still the server's current one; otherwise
   * {@link AgentSessionReplacedError} is thrown and nothing is written.
   * Requires `reportId`, because a fenced report is replayed on the next session.
   */
  sessionId?: string;
  windowStartedAt: Date | null;
  windowEndedAt: Date | null;
  entries: TrafficReportRow[];
}

export interface RecordTrafficResult {
  accepted: number;
  dropped: number;
  /** The report id had already been applied; nothing was written. */
  duplicate: boolean;
}

/**
 * The WebSocket session that submitted a report is no longer the server's
 * current session. Nothing was written; the agent resends the report on its
 * current session, where the ledger deduplicates it.
 */
export class AgentSessionReplacedError extends Error {
  constructor() {
    super("agent websocket session was replaced");
    this.name = "AgentSessionReplacedError";
  }
}

/** The report id was already used by this server for different content. */
export class TrafficReportConflictError extends Error {
  constructor() {
    super("traffic report id was already used with different content");
    this.name = "TrafficReportConflictError";
  }
}

/**
 * Stable digest of the request as the agent sent it (before attribution), used
 * to tell a genuine retry from a reused id. Entry order is irrelevant.
 */
export function computeTrafficReportHash(report: {
  windowStartedAt?: string;
  windowEndedAt?: string;
  entries: {
    subscriptionId: string;
    uplinkBytes: number;
    downlinkBytes: number;
  }[];
}): string {
  const entries = report.entries
    .map((e) => [e.subscriptionId, e.uplinkBytes, e.downlinkBytes] as const)
    .sort((a, b) =>
      a[0] === b[0]
        ? a[1] === b[1]
          ? a[2] - b[2]
          : a[1] - b[1]
        : a[0] < b[0]
          ? -1
          : 1,
    );
  return createHash("sha256")
    .update(
      JSON.stringify([
        report.windowStartedAt ?? null,
        report.windowEndedAt ?? null,
        entries,
      ]),
    )
    .digest("hex");
}

/**
 * Applies one traffic report: history rows, subscription counters and (when the
 * report has an id) the idempotency ledger row, all in ONE SQL statement.
 *
 * Why one statement: `neon-http` has no interactive transactions, so ordinary
 * sequential writes can fail half-way and a retry then double-counts what
 * already landed. A single statement with data-modifying CTEs is atomic on both
 * drivers (PostgreSQL runs it in one implicit transaction; neon-http sends it
 * as one request). The `claim` CTE inserts the ledger row with
 * `ON CONFLICT DO NOTHING`; `history` and `usage` only run when that insert
 * produced a row. Two concurrent deliveries of the same report both reach the
 * unique index; the loser blocks until the winner commits, then inserts
 * nothing, so exactly one of them writes history and counters.
 *
 * Without a `reportId` (legacy agents) the statement is still atomic, but a
 * replay after a lost response is counted again: there is nothing to
 * recognise it by.
 *
 * Unknown subscriptions are dropped (counted in `dropped`); expired or
 * cancelled ones still accrue, as before.
 */
export async function recordAgentTraffic(
  report: RecordTrafficReport,
): Promise<RecordTrafficResult> {
  const database = report.database ?? db;
  const { serverId, reportId, sessionId } = report;
  if (reportId !== undefined && !report.contentHash) {
    throw new Error("contentHash is required with reportId");
  }
  if (sessionId !== undefined && reportId === undefined) {
    throw new Error("sessionId requires reportId");
  }
  const rows = JSON.stringify(
    report.entries.map((e) => ({
      id: randomUUID(),
      subscription_id: e.subscriptionId,
      node_id: e.nodeId,
      uplink_bytes: e.uplinkBytes,
      downlink_bytes: e.downlinkBytes,
    })),
  );
  const windowStartedAt = report.windowStartedAt?.toISOString() ?? null;
  const windowEndedAt = report.windowEndedAt?.toISOString() ?? null;

  // The fence row is locked FOR SHARE, so a session replacement (which updates
  // the same row) waits until this statement commits. A write therefore either
  // lands before the replacement or is rejected by it, never in between.
  const fenceCte =
    sessionId === undefined
      ? sql``
      : sql`fence AS (
          SELECT 1 FROM server
          WHERE id = ${serverId}::text
            AND ws_session_id = ${sessionId}::text
            AND ${currentAgentCredentialSql()}
          FOR SHARE
        ),`;
  const fenceGuard =
    sessionId === undefined ? sql`` : sql`WHERE EXISTS (SELECT 1 FROM fence)`;
  const claimCte =
    reportId === undefined
      ? sql``
      : sql`claim AS (
          INSERT INTO traffic_report (id, server_id, report_id, content_hash, accepted, dropped, created_at)
          SELECT ${randomUUID()}::text, ${serverId}::text, ${reportId}::text, ${report.contentHash}::text,
                 (SELECT count(*) FROM resolved)::int,
                 ((SELECT count(*) FROM incoming) - (SELECT count(*) FROM resolved))::int,
                 timezone('utc', now())
          ${fenceGuard}
          ON CONFLICT (server_id, report_id) DO NOTHING
          RETURNING id
        ),`;
  const apply =
    reportId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM claim)`;
  const claimedColumn =
    reportId === undefined ? sql`1` : sql`(SELECT count(*) FROM claim)::int`;
  const fencedColumn =
    sessionId === undefined ? sql`1` : sql`(SELECT count(*) FROM fence)::int`;

  const statement = sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${rows}::jsonb)
        AS e(id text, subscription_id text, node_id text, uplink_bytes bigint, downlink_bytes bigint)
    ),
    resolved AS (
      SELECT i.id, i.subscription_id, s.user_id, i.node_id, i.uplink_bytes, i.downlink_bytes
      FROM incoming i JOIN subscription s ON s.id = i.subscription_id
    ),
    ${fenceCte}
    ${claimCte}
    history AS (
      INSERT INTO traffic_record (id, subscription_id, user_id, node_id, server_id, uplink_bytes, downlink_bytes, window_started_at, window_ended_at)
      SELECT r.id, r.subscription_id, r.user_id, r.node_id, ${serverId}::text, r.uplink_bytes, r.downlink_bytes,
             ${windowStartedAt}::timestamp, ${windowEndedAt}::timestamp
      FROM resolved r
      WHERE ${apply}
      RETURNING id
    ),
    usage AS (
      UPDATE subscription s
      SET traffic_used_bytes = s.traffic_used_bytes + t.delta::bigint,
          updated_at = timezone('utc', now())
      FROM (
        SELECT subscription_id, sum(uplink_bytes + downlink_bytes) AS delta
        FROM resolved GROUP BY subscription_id
      ) t
      WHERE s.id = t.subscription_id AND ${apply}
      RETURNING s.id
    )
    SELECT ${claimedColumn} AS claimed,
           ${fencedColumn} AS fenced,
           (SELECT count(*) FROM history)::int AS accepted,
           ((SELECT count(*) FROM incoming) - (SELECT count(*) FROM resolved))::int AS dropped,
           (SELECT count(*) FROM usage)::int AS usage_rows
  `;

  // A pruned ledger row can vanish between the conflict and the lookup below;
  // one more attempt then applies the report as a fresh delivery.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [outcome] = await database.execute<{
      claimed: number;
      fenced: number;
      accepted: number;
      dropped: number;
    }>(statement, "objects");
    if (!outcome) {
      throw new Error("traffic statement returned no row");
    }
    if (sessionId !== undefined && Number(outcome.fenced) === 0) {
      throw new AgentSessionReplacedError();
    }
    if (Number(outcome.claimed) > 0) {
      if (reportId !== undefined) {
        await pruneTrafficReports(serverId, database);
      }
      return {
        accepted: Number(outcome.accepted),
        dropped: Number(outcome.dropped),
        duplicate: false,
      };
    }

    const [existing] = await database
      .select()
      .from(trafficReport)
      .where(
        and(
          eq(trafficReport.serverId, serverId),
          eq(trafficReport.reportId, reportId!),
        ),
      );
    if (!existing) continue;
    if (existing.contentHash !== report.contentHash) {
      throw new TrafficReportConflictError();
    }
    return {
      accepted: existing.accepted,
      dropped: existing.dropped,
      duplicate: true,
    };
  }
  throw new Error("traffic report could not be recorded");
}

/** Best-effort retention pruning; never fails the report it piggybacks on. */
async function pruneTrafficReports(
  serverId: string,
  database: DbHandle,
): Promise<void> {
  const cutoff = new Date(
    Date.now() - TRAFFIC_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    await database.execute(
      sql`
      DELETE FROM traffic_report WHERE id IN (
        SELECT id FROM traffic_report
        WHERE server_id = ${serverId}::text AND created_at < ${cutoff}::timestamp
        LIMIT ${TRAFFIC_REPORT_PRUNE_BATCH}
      )
    `,
      "objects",
    );
  } catch {
    // Retention is housekeeping; the next report prunes again.
  }
}
