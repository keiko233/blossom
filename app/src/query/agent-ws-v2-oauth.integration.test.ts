/**
 * OAuth identity handshake, pending proof, rotation, revocation, expiry and
 * server deletion against a REAL, DISPOSABLE PostgreSQL. Gated by
 * `BLOSSOM_TEST_DATABASE_URL` (name `blossom_test*`) and
 * `BLOSSOM_TEST_CONFIRM_DISPOSABLE=yes`; run with `--no-file-parallelism`.
 * The neon-http driver joins when `BLOSSOM_TEST_NEON_HTTP_URL` and
 * `BLOSSOM_TEST_NEON_HTTP_ENDPOINT` point at a local `/sql` proxy.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "@blossom/database/server";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { verifyAgentAccessToken } from "@/lib/agent-oauth";
import {
  AGENT_MACHINE_SCOPE,
  createOAuthProviderOptions,
  getOAuthResourceIdentifiers,
} from "@/lib/oauth-provider-config";

import {
  loadCurrentAgentServer,
  promoteAgentV2WsSession,
  revalidatePendingAgentV2Session,
  startAgentV2WsSession,
  type AgentSessionCredential,
} from "./agent";
import {
  createEnrollmentGrant,
  redeemEnrollmentGrant,
  revokeAgentIdentity,
} from "./agent-identity-store";
import { applyAgentCertificateDeployments } from "./certificate-agent";
import { deleteServerRecord } from "./server-deletion";

const pgUrl = process.env.BLOSSOM_TEST_DATABASE_URL;
const neonUrl = process.env.BLOSSOM_TEST_NEON_HTTP_URL;
const neonEndpoint = process.env.BLOSSOM_TEST_NEON_HTTP_ENDPOINT;

if (pgUrl || neonUrl || neonEndpoint) {
  if (process.env.BLOSSOM_TEST_CONFIRM_DISPOSABLE !== "yes") {
    throw new Error(
      "OAuth v2 integration tests require explicit disposable database confirmation",
    );
  }
  for (const url of [pgUrl, neonUrl]) {
    if (
      url &&
      !decodeURIComponent(new URL(url).pathname.slice(1)).startsWith(
        "blossom_test",
      )
    ) {
      throw new Error(
        "OAuth v2 integration tests require a database named blossom_test*",
      );
    }
  }
}

const ORIGIN = "http://localhost:3000";
const RESOURCES = getOAuthResourceIdentifiers(ORIGIN);
const OPERATOR = "oauth-operator";

type Driver = "node-postgres" | "neon-http";
const drivers: Driver[] = ["node-postgres"];
if (pgUrl && neonUrl && neonEndpoint) drivers.push("neon-http");

const admin = new Pool({ connectionString: pgUrl, max: 4 });
afterAll(async () => {
  await admin.end();
});

let auth: ReturnType<typeof buildAuth>;
let authPool: Pool;

function buildAuth(database: Database) {
  return betterAuth({
    baseURL: ORIGIN,
    secret: "test-only-secret-not-real",
    database: drizzleAdapter(database, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { expirationTime: "15m" } }),
      oauthProvider(createOAuthProviderOptions(RESOURCES)),
    ],
  });
}

async function useDriver(driver: Driver) {
  if (driver === "node-postgres") {
    const pool = new Pool({ connectionString: pgUrl, max: 16 });
    return {
      database: drizzle({ client: pool }) as Database,
      close: () => pool.end(),
    };
  }
  const { neon, neonConfig } = await import("@neondatabase/serverless");
  const { drizzle: neonDrizzle } = await import("drizzle-orm/neon-http");
  neonConfig.fetchEndpoint = () => neonEndpoint!;
  return {
    database: neonDrizzle({ client: neon(neonUrl!) }) as Database,
    close: async () => {},
  };
}

async function tokenFor(clientId: string, secret: string) {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: RESOURCES.agent,
        scope: AGENT_MACHINE_SCOPE,
      }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status).toBe(200);
  return String(body.access_token);
}

function oauthCredential(identity: {
  identityId: string;
  clientId: string;
  generation: number;
  expiresAt: number;
  identityStatus: "pending" | "active";
}): Extract<AgentSessionCredential, { kind: "oauth" }> {
  return {
    kind: "oauth",
    identityId: identity.identityId,
    clientId: identity.clientId,
    generation: identity.generation,
    expiresAt: identity.expiresAt,
    identityStatus: identity.identityStatus,
  };
}

async function verify(
  database: Database,
  token: string,
  purpose: "handshake" | "session",
) {
  return verifyAgentAccessToken(database, token, {
    issuer: `${ORIGIN}/api/auth`,
    audience: RESOURCES.agent,
    getJwks: () => auth.api.getJwks(),
    purpose,
  });
}

async function enroll(
  database: Database,
  serverId: string,
  mode: "enroll" | "replace",
) {
  const { secret } = await createEnrollmentGrant(database, {
    serverId,
    mode,
    capabilities: ["ws"],
    release: "test",
    createdById: OPERATOR,
    now: new Date(),
  });
  const result = await redeemEnrollmentGrant(database, {
    secret,
    resources: RESOURCES,
    now: new Date(),
  });
  if (!result.ok) throw new Error(`redemption failed: ${result.reason}`);
  if (result.serverId !== serverId) throw new Error("wrong server");
  return result;
}

async function seed(serverId = "srv-oauth") {
  await admin.query(
    `INSERT INTO "user" (id, name, email, role)
     VALUES ($1, 'Operator', 'operator@example.test', 'admin')
     ON CONFLICT (id) DO NOTHING`,
    [OPERATOR],
  );
  await admin.query(
    `INSERT INTO server (id, name, address, enabled, agent_token_hash, agent_token_prefix)
     VALUES ($1, 'OAuth', 'oauth.example.test', true, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [serverId, `${serverId}-static-hash`, `${serverId}-static`],
  );
}

describe.skipIf(!pgUrl).each(drivers)(
  "OAuth agent v2 identity on %s",
  (driver) => {
    let database: Database;
    let close: () => Promise<unknown>;

    beforeAll(async () => {
      authPool = new Pool({ connectionString: pgUrl, max: 8 });
      const authDb = drizzle({ client: authPool }) as Database;
      await admin.query(
        "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
      );
      await migrate(drizzle({ client: admin }), {
        migrationsFolder: fileURLToPath(
          new URL("../../drizzle", import.meta.url),
        ),
      });
      auth = buildAuth(authDb);
      ({ database, close } = await useDriver(driver));
    }, 120_000);

    afterAll(async () => {
      await close();
      await authPool?.end();
    });

    beforeEach(async () => {
      await admin.query(
        `TRUNCATE agent_identity, agent_enrollment_grant, oauth_access_token,
           oauth_client_resource, oauth_client, oauth_resource, admin_audit_log,
           certificate_server, certificate_material, managed_certificate,
           server, "user" CASCADE`,
      );
      await seed();
    });

    it("promotes the first pending identity only after its handshake proof", async () => {
      const enrolled = await enroll(database, "srv-oauth", "enroll");
      const token = await tokenFor(enrolled.clientId, enrolled.clientSecret);
      const verified = await verify(database, token, "handshake");
      expect(verified).toMatchObject({
        serverId: "srv-oauth",
        identityId: enrolled.identityId,
        identityStatus: "pending",
      });

      const credential = oauthCredential(verified);
      const session = await startAgentV2WsSession(
        "srv-oauth",
        credential,
        database,
      );
      expect(session).toMatchObject({ pending: true });
      expect(
        await loadCurrentAgentServer("srv-oauth", session!.sessionId, database),
      ).toBeNull();
      expect(
        await revalidatePendingAgentV2Session(
          "srv-oauth",
          credential,
          database,
        ),
      ).toBe(true);

      const promoted = await promoteAgentV2WsSession(
        "srv-oauth",
        session!.sessionId,
        credential,
        database,
      );
      expect(promoted).not.toBeNull();
      const { rows } = await admin.query(
        `SELECT status, generation FROM agent_identity WHERE id = $1`,
        [enrolled.identityId],
      );
      expect(rows).toEqual([{ status: "active", generation: 1 }]);
      expect(
        await loadCurrentAgentServer("srv-oauth", session!.sessionId, database),
      ).toMatchObject({
        id: "srv-oauth",
        wsCredentialIdentityId: enrolled.identityId,
      });
    });

    it("rotates generations, fences the old session, and rejects replayed tokens", async () => {
      const first = await enroll(database, "srv-oauth", "enroll");
      const firstToken = await tokenFor(first.clientId, first.clientSecret);
      const firstUse = await verify(database, firstToken, "handshake");
      const firstCredential = oauthCredential(firstUse);
      const firstSession = await startAgentV2WsSession(
        "srv-oauth",
        firstCredential,
        database,
      );
      await promoteAgentV2WsSession(
        "srv-oauth",
        firstSession!.sessionId,
        firstCredential,
        database,
      );

      const second = await enroll(database, "srv-oauth", "replace");
      const secondToken = await tokenFor(second.clientId, second.clientSecret);
      const secondUse = await verify(database, secondToken, "handshake");
      expect(secondUse).toMatchObject({
        identityStatus: "pending",
        generation: 2,
      });
      const secondCredential = oauthCredential(secondUse);
      const secondSession = await startAgentV2WsSession(
        "srv-oauth",
        secondCredential,
        database,
      );
      expect(secondSession).toMatchObject({ pending: true });
      // The pending probe does not displace the live generation before proof.
      expect(
        await loadCurrentAgentServer(
          "srv-oauth",
          firstSession!.sessionId,
          database,
        ),
      ).not.toBeNull();

      await promoteAgentV2WsSession(
        "srv-oauth",
        secondSession!.sessionId,
        secondCredential,
        database,
      );
      expect(
        await loadCurrentAgentServer(
          "srv-oauth",
          firstSession!.sessionId,
          database,
        ),
      ).toBeNull();
      expect(
        await loadCurrentAgentServer(
          "srv-oauth",
          secondSession!.sessionId,
          database,
        ),
      ).not.toBeNull();

      const { rows } = await admin.query(
        `SELECT id, status FROM agent_identity ORDER BY generation`,
      );
      expect(rows).toEqual([
        { id: first.identityId, status: "superseded" },
        { id: second.identityId, status: "active" },
      ]);

      await expect(
        verify(database, firstToken, "session"),
      ).rejects.toMatchObject({ code: "identity_not_usable" });
      await expect(
        verify(database, firstToken, "handshake"),
      ).rejects.toMatchObject({ code: "identity_not_usable" });
      await expect(
        verify(database, secondToken, "session"),
      ).resolves.toMatchObject({
        identityId: second.identityId,
        generation: 2,
      });
    });

    it("recovers a rotation interrupted after the old generation was demoted", async () => {
      const first = await enroll(database, "srv-oauth", "enroll");
      const firstToken = await tokenFor(first.clientId, first.clientSecret);
      const firstUse = await verify(database, firstToken, "handshake");
      const firstCredential = oauthCredential(firstUse);
      const firstSession = await startAgentV2WsSession(
        "srv-oauth",
        firstCredential,
        database,
      );
      await promoteAgentV2WsSession(
        "srv-oauth",
        firstSession!.sessionId,
        firstCredential,
        database,
      );

      const second = await enroll(database, "srv-oauth", "replace");
      const secondToken = await tokenFor(second.clientId, second.clientSecret);
      const secondUse = await verify(database, secondToken, "handshake");
      const secondCredential = oauthCredential(secondUse);
      const secondSession = await startAgentV2WsSession(
        "srv-oauth",
        secondCredential,
        database,
      );
      // Simulate a process stopping after demote and before promote. The next
      // handshake's conditional promotion must finish the switch.
      await admin.query(
        `UPDATE agent_identity SET status = 'superseded' WHERE id = $1`,
        [first.identityId],
      );
      const promoted = await promoteAgentV2WsSession(
        "srv-oauth",
        secondSession!.sessionId,
        secondCredential,
        database,
      );
      expect(promoted).not.toBeNull();
      const { rows } = await admin.query(
        `SELECT id, status FROM agent_identity ORDER BY generation`,
      );
      expect(rows).toEqual([
        { id: first.identityId, status: "superseded" },
        { id: second.identityId, status: "active" },
      ]);
    });

    it("ends the fence and rejects the token after revocation or expiry", async () => {
      const enrolled = await enroll(database, "srv-oauth", "enroll");
      const token = await tokenFor(enrolled.clientId, enrolled.clientSecret);
      const use = await verify(database, token, "handshake");
      const credential = oauthCredential(use);
      const session = await startAgentV2WsSession(
        "srv-oauth",
        credential,
        database,
      );
      await promoteAgentV2WsSession(
        "srv-oauth",
        session!.sessionId,
        credential,
        database,
      );

      // Expiry alone removes the fence even while the identity is active.
      await admin.query(
        `UPDATE server SET ws_credential_expires_at = timezone('utc', now()) - interval '1 second'
         WHERE id = 'srv-oauth'`,
      );
      expect(
        await loadCurrentAgentServer("srv-oauth", session!.sessionId, database),
      ).toBeNull();

      await admin.query(
        `UPDATE server SET ws_credential_expires_at = timezone('utc', now()) + interval '10 minutes'
         WHERE id = 'srv-oauth'`,
      );
      await revokeAgentIdentity(database, {
        identityId: enrolled.identityId,
        now: new Date(),
      });
      expect(
        await loadCurrentAgentServer("srv-oauth", session!.sessionId, database),
      ).toBeNull();
      await expect(verify(database, token, "session")).rejects.toMatchObject({
        code: "client_disabled",
      });
    });

    it("refuses certificate deployment writes from a replaced session", async () => {
      await admin.query(
        `INSERT INTO managed_certificate
           (id, name, kind, domains, active_material_version, desired_generation, state)
         VALUES ('cert-1', 'cert', 'self_signed', '["cert.example.test"]'::jsonb, 1, 1, 'active')`,
      );
      await admin.query(
        `INSERT INTO certificate_material
           (id, certificate_id, version, certificate_ciphertext, private_key_ciphertext,
            domains, not_before, not_after, fingerprint_sha256)
         VALUES ('mat-1', 'cert-1', 1, 'unused', 'unused',
                 '["cert.example.test"]'::jsonb, now(), now() + interval '1 year', 'fp-1')`,
      );
      await admin.query(
        `INSERT INTO certificate_server
           (certificate_id, server_id, enabled, desired_generation)
         VALUES ('cert-1', 'srv-oauth', true, 1)`,
      );
      const old = await startAgentV2WsSession(
        "srv-oauth",
        { kind: "static", tokenHash: "srv-oauth-static-hash" },
        database,
      );
      const current = await startAgentV2WsSession(
        "srv-oauth",
        { kind: "static", tokenHash: "srv-oauth-static-hash" },
        database,
      );
      expect(old).not.toBeNull();
      expect(current).not.toBeNull();
      const deployment = {
        certificateId: "cert-1",
        generation: 1,
        fingerprintSha256: "fp-1",
        installed: true,
        inUse: true,
      };

      await applyAgentCertificateDeployments("srv-oauth", [deployment], {
        sessionId: old!.sessionId,
        database,
      });
      let { rows } = await admin.query(
        `SELECT state, applied_generation FROM certificate_server
         WHERE certificate_id = 'cert-1' AND server_id = 'srv-oauth'`,
      );
      expect(rows).toEqual([{ state: "pending", applied_generation: null }]);

      await applyAgentCertificateDeployments("srv-oauth", [deployment], {
        sessionId: current!.sessionId,
        database,
      });
      ({ rows } = await admin.query(
        `SELECT state, applied_generation FROM certificate_server
         WHERE certificate_id = 'cert-1' AND server_id = 'srv-oauth'`,
      ));
      expect(rows).toEqual([{ state: "active", applied_generation: 1 }]);
    });

    it("deletes a server with an identity without leaving a usable client", async () => {
      const enrolled = await enroll(database, "srv-oauth", "enroll");
      await admin.query(
        `INSERT INTO admin_audit_log (id, action, target_type, target_id, status)
         VALUES ('audit-delete', 'server.delete', 'server', 'srv-oauth', 'success')`,
      );
      // Revoked identities used to block the RESTRICT foreign key.
      await revokeAgentIdentity(database, {
        identityId: enrolled.identityId,
        now: new Date(),
      });

      const deleted = await deleteServerRecord("srv-oauth", {
        database,
        interactive: driver === "node-postgres",
      });
      expect(deleted).toEqual({ id: "srv-oauth" });
      expect(
        (await admin.query(`SELECT 1 FROM server WHERE id = 'srv-oauth'`))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(
            `SELECT 1 FROM agent_identity WHERE server_id = 'srv-oauth'`,
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(`SELECT 1 FROM oauth_client WHERE client_id = $1`, [
            enrolled.clientId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(
            `SELECT 1 FROM oauth_client_resource WHERE client_id = $1`,
            [enrolled.clientId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(
            `SELECT 1 FROM admin_audit_log WHERE id = 'audit-delete'`,
          )
        ).rowCount,
      ).toBe(1);
    });
  },
);
