/**
 * Enrollment and identity state against a REAL, DISPOSABLE PostgreSQL, using the
 * production OAuth provider options for the end-to-end token checks. Skipped
 * unless BLOSSOM_TEST_PG_URL is set (loopback host, database named
 * `blossom_disposable_*`; the public schema is dropped and rebuilt).
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "@blossom/database/server";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { handleEnrollmentRedeem } from "@/lib/agent-enrollment-route";
import { AgentAuthError, verifyAgentAccessToken } from "@/lib/agent-oauth";
import {
  AGENT_MACHINE_SCOPE,
  AGENT_TOKEN_LIFETIME_SECONDS,
  createOAuthProviderOptions,
  getOAuthResourceIdentifiers,
} from "@/lib/oauth-provider-config";

import {
  createEnrollmentGrant,
  listAgentIdentities,
  listEnrollmentGrants,
  redeemEnrollmentGrant,
  revokeAgentIdentity,
  revokeEnrollmentGrant,
} from "./agent-identity-store";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const ORIGIN = "http://localhost:3000";
const RESOURCES = getOAuthResourceIdentifiers(ORIGIN);
const OPERATOR = "enroll-operator";
const hashClientSecret = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

function assertDisposable(raw: string) {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (
    !loopback.includes(url.hostname) ||
    !dbName.startsWith("blossom_disposable_")
  ) {
    throw new Error(
      "BLOSSOM_TEST_PG_URL must be a loopback blossom_disposable_* database",
    );
  }
}

let pool: Pool;
let db: Database;
let auth: ReturnType<typeof buildAuth>;

function buildAuth(database: Database) {
  return betterAuth({
    baseURL: ORIGIN,
    secret: "fake-enroll-secret-0123456789abcdefghijklmnopqrstuvwx",
    database: drizzleAdapter(database, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { expirationTime: "15m" } }),
      oauthProvider(createOAuthProviderOptions(RESOURCES)),
    ],
  });
}

async function resetAndSeed() {
  await pool.query(
    `TRUNCATE agent_identity, agent_enrollment_grant, oauth_access_token,
       oauth_client_resource, oauth_client, oauth_resource, server, "user" CASCADE`,
  );
  await pool.query(
    `INSERT INTO "user" (id, name, email, role) VALUES ($1, 'Operator', 'operator@example.test', 'admin')`,
    [OPERATOR],
  );
  await pool.query(
    `INSERT INTO server (id, name, address, enabled, agent_token_hash, agent_token_prefix) VALUES
       ('srv-a', 'A', 'a.example.test', true, 'fake-hash-a', 'fake-a'),
       ('srv-b', 'B', 'b.example.test', true, 'fake-hash-b', 'fake-b'),
       ('srv-off', 'Off', 'off.example.test', false, 'fake-hash-off', 'fake-off')`,
  );
}

const now = () => new Date();

function grantFor(
  serverId: string,
  mode: "enroll" | "replace" = "enroll",
  at = now(),
) {
  return createEnrollmentGrant(db, {
    serverId,
    mode,
    capabilities: ["ws"],
    release: "server-agent-v0.0.0-test",
    createdById: OPERATOR,
    now: at,
  });
}

function redeem(secret: string, at = now()) {
  return redeemEnrollmentGrant(db, { secret, resources: RESOURCES, now: at });
}

async function identityRows(serverId: string) {
  return pool.query(
    `SELECT id, generation, status, oauth_client_id FROM agent_identity WHERE server_id = $1 ORDER BY generation`,
    [serverId],
  );
}

async function setIdentityActive(identityId: string) {
  // Stands in for the first-handshake promotion, which the WebSocket follow-up owns.
  await pool.query(
    `UPDATE agent_identity SET status = 'active', activated_at = now() WHERE id = $1`,
    [identityId],
  );
}

async function tokenFor(clientId: string, secret: string) {
  const res = await auth.handler(
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
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe.skipIf(!PG_URL)(
  "agent identity enrollment (disposable PostgreSQL)",
  () => {
    beforeAll(async () => {
      assertDisposable(PG_URL!);
      pool = new Pool({ connectionString: PG_URL, max: 12 });
      await pool.query(
        "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
      );
      db = drizzle({ client: pool });
      await migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL("../../drizzle", import.meta.url),
        ),
      });
      auth = buildAuth(db);
    }, 120_000);

    beforeEach(resetAndSeed);

    afterAll(async () => {
      await pool?.end();
    });

    describe("redemption", () => {
      it("creates a pending identity, a machine client, and the agent link in one step", async () => {
        const { grant, secret } = await grantFor("srv-a");
        expect(secret.startsWith("egr_")).toBe(true);
        const result = await redeem(secret);
        expect(result).toMatchObject({
          ok: true,
          serverId: "srv-a",
          generation: 1,
        });
        if (!result.ok) throw new Error("unreachable");

        const identities = await identityRows("srv-a");
        expect(identities.rows).toEqual([
          expect.objectContaining({
            generation: 1,
            status: "pending",
            oauth_client_id: result.clientId,
          }),
        ]);
        const link = await pool.query(
          `SELECT 1 FROM oauth_client_resource WHERE client_id = $1 AND resource_id = $2`,
          [result.clientId, RESOURCES.agent],
        );
        expect(link.rowCount).toBe(1);
        const grantRow = await pool.query(
          `SELECT status, attempt_id FROM agent_enrollment_grant WHERE id = $1`,
          [grant.id],
        );
        expect(grantRow.rows[0]).toMatchObject({ status: "redeemed" });
      });

      it("never stores the plaintext grant or client secret", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        const stored = await pool.query(
          `SELECT
           (SELECT count(*) FROM agent_enrollment_grant WHERE token_hash = $1)::int AS grant_plain,
           (SELECT count(*) FROM oauth_client WHERE client_secret = $2)::int AS client_plain,
           (SELECT token_hash FROM agent_enrollment_grant LIMIT 1) AS stored_hash,
           (SELECT client_secret FROM oauth_client WHERE client_id = $3) AS stored_secret`,
          [secret, result.clientSecret, result.clientId],
        );
        expect(stored.rows[0]).toMatchObject({
          grant_plain: 0,
          client_plain: 0,
        });
        expect(stored.rows[0].stored_hash).toBe(
          createHash("sha256").update(secret).digest("hex"),
        );
        expect(stored.rows[0].stored_secret).not.toBe(result.clientSecret);
      });

      it("lets exactly one of many concurrent redemptions of one grant win", async () => {
        const { secret } = await grantFor("srv-a");
        const results = await Promise.all(
          Array.from({ length: 8 }, () => redeem(secret)),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(
          results
            .filter((r) => !r.ok)
            .every((r) => !r.ok && r.reason === "grant_unavailable"),
        ).toBe(true);
        expect((await identityRows("srv-a")).rows).toHaveLength(1);
      });

      it("releases the claim of the loser when two grants race for one pending slot", async () => {
        const first = await grantFor("srv-a");
        const second = await grantFor("srv-a");
        const results = await Promise.all([
          redeem(first.secret),
          redeem(second.secret),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const loserId =
          results.findIndex((r) => !r.ok) === 0
            ? first.grant.id
            : second.grant.id;
        const loser = await pool.query(
          `SELECT status, attempt_id FROM agent_enrollment_grant WHERE id = $1`,
          [loserId],
        );
        expect(loser.rows[0]).toEqual({ status: "issued", attempt_id: null });
        expect((await identityRows("srv-a")).rows).toHaveLength(1);
      });

      it("reports a replayed grant as unavailable, not as invalid, and creates nothing", async () => {
        const { secret } = await grantFor("srv-a");
        expect((await redeem(secret)).ok).toBe(true);
        expect(await redeem(secret)).toEqual({
          ok: false,
          reason: "grant_unavailable",
        });
        expect((await identityRows("srv-a")).rows).toHaveLength(1);
      });

      it("refuses unknown, expired, and revoked grants as invalid", async () => {
        expect(await redeem("egr_" + "A".repeat(43))).toEqual({
          ok: false,
          reason: "invalid_grant",
        });

        const expired = await grantFor(
          "srv-a",
          "enroll",
          new Date(Date.now() - 60 * 60_000),
        );
        expect(await redeem(expired.secret)).toEqual({
          ok: false,
          reason: "invalid_grant",
        });

        const revoked = await grantFor("srv-a");
        await revokeEnrollmentGrant(db, {
          grantId: revoked.grant.id,
          now: now(),
        });
        expect(await redeem(revoked.secret)).toEqual({
          ok: false,
          reason: "invalid_grant",
        });
        expect((await identityRows("srv-a")).rows).toHaveLength(0);
      });

      it("refuses redemption for a disabled server", async () => {
        const { secret } = await grantFor("srv-off");
        expect(await redeem(secret)).toEqual({
          ok: false,
          reason: "server_disabled",
        });
        expect((await identityRows("srv-off")).rows).toHaveLength(0);
      });

      it("keeps enroll and replace mode consistent with the server's active identity", async () => {
        const enrolled = await grantFor("srv-a");
        const first = await redeem(enrolled.secret);
        if (!first.ok) throw new Error("unreachable");
        // Issued while the identity was still pending, so creation allowed it.
        const stale = await grantFor("srv-a");
        await setIdentityActive(first.identityId);

        // Redemption re-checks the active identity atomically in the claim.
        expect(await redeem(stale.secret)).toEqual({
          ok: false,
          reason: "grant_unavailable",
        });
        await expect(grantFor("srv-a")).rejects.toThrow(/replace it instead/);

        const replacement = await grantFor("srv-a", "replace");
        const second = await redeem(replacement.secret);
        expect(second).toMatchObject({ ok: true, generation: 2 });
        const rows = await identityRows("srv-a");
        expect(rows.rows.map((r) => r.status)).toEqual(["active", "pending"]);
      });

      it("refuses replace when the server has no active identity", async () => {
        await expect(grantFor("srv-b", "replace")).rejects.toThrow(
          /no active agent identity/,
        );
      });
    });

    describe("lost responses and recovery", () => {
      it("recovers from a lost redeem response by revoking the grant and issuing a fresh one", async () => {
        const lost = await grantFor("srv-a");
        const delivered = await redeem(lost.secret);
        if (!delivered.ok) throw new Error("unreachable");
        // The response never arrived, so the agent retries and gets no secret.
        expect(await redeem(lost.secret)).toEqual({
          ok: false,
          reason: "grant_unavailable",
        });

        const revoked = await revokeEnrollmentGrant(db, {
          grantId: lost.grant.id,
          now: now(),
        });
        expect(revoked).toEqual({
          found: true,
          serverId: "srv-a",
          grantStatus: "revoked",
        });

        const pending = await identityRows("srv-a");
        expect(pending.rows[0]).toMatchObject({ status: "revoked" });
        const client = await pool.query(
          `SELECT disabled FROM oauth_client WHERE client_id = $1`,
          [delivered.clientId],
        );
        expect(client.rows[0]).toEqual({ disabled: true });
        const links = await pool.query(
          `SELECT 1 FROM oauth_client_resource WHERE client_id = $1`,
          [delivered.clientId],
        );
        expect(links.rowCount).toBe(0);

        const fresh = await grantFor("srv-a");
        const retried = await redeem(fresh.secret);
        expect(retried).toMatchObject({ ok: true, generation: 2 });
      });

      it("revokes an identity idempotently and finishes partially completed cleanup", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        const first = await revokeAgentIdentity(db, {
          identityId: result.identityId,
          now: now(),
        });
        expect(first).toEqual({
          found: true,
          serverId: "srv-a",
          changed: true,
        });

        // Simulate a crash after the identity update but before the client cleanup.
        await pool.query(
          `UPDATE oauth_client SET disabled = false WHERE client_id = $1`,
          [result.clientId],
        );
        await pool.query(
          `INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES ('x', $1, $2)`,
          [result.clientId, RESOURCES.agent],
        );
        const retry = await revokeAgentIdentity(db, {
          identityId: result.identityId,
          now: now(),
        });
        expect(retry).toEqual({
          found: true,
          serverId: "srv-a",
          changed: false,
        });
        const client = await pool.query(
          `SELECT disabled FROM oauth_client WHERE client_id = $1`,
          [result.clientId],
        );
        expect(client.rows[0]).toEqual({ disabled: true });
        expect(
          (
            await pool.query(
              `SELECT 1 FROM oauth_client_resource WHERE client_id = $1`,
              [result.clientId],
            )
          ).rowCount,
        ).toBe(0);

        expect(
          await revokeAgentIdentity(db, { identityId: "missing", now: now() }),
        ).toEqual({ found: false });
      });

      it("does not revoke an active identity through its grant", async () => {
        const { grant, secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        await setIdentityActive(result.identityId);
        await revokeEnrollmentGrant(db, { grantId: grant.id, now: now() });
        expect((await identityRows("srv-a")).rows[0]).toMatchObject({
          status: "active",
        });
      });
    });

    describe("provider end to end", () => {
      it("issues a machine token only after redemption, and stops after revocation", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");

        const issued = await tokenFor(result.clientId, result.clientSecret);
        expect(issued.status).toBe(200);
        expect(issued.body.scope).toBe(AGENT_MACHINE_SCOPE);

        await revokeAgentIdentity(db, {
          identityId: result.identityId,
          now: now(),
        });
        const after = await tokenFor(result.clientId, result.clientSecret);
        expect(after.status).toBe(401);
        expect(after.body.error).toBe("invalid_client");
      });

      it("refuses a replayed or wrong client secret", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        expect(
          (await tokenFor(result.clientId, "ags_" + "B".repeat(43))).status,
        ).toBe(401);
      });

      it("keeps the agent lifetime at 15 minutes for the issued token", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        const issued = await tokenFor(result.clientId, result.clientSecret);
        expect(issued.body.expires_in).toBe(AGENT_TOKEN_LIFETIME_SECONDS);
      });
    });

    describe("HTTP redeem handler", () => {
      const deps = () => ({ db, resources: RESOURCES, origin: ORIGIN });
      const post = (body: unknown, contentType = "application/json") =>
        handleEnrollmentRedeem(
          new Request(`${ORIGIN}/api/agent/enrollment/redeem`, {
            method: "POST",
            headers: { "content-type": contentType },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
          deps(),
        );

      it("returns the one-time credentials with no-store and the token endpoint details", async () => {
        const { secret } = await grantFor("srv-a");
        const res = await post({ enrollmentGrant: secret });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          serverId: "srv-a",
          identityStatus: "pending",
          grantType: "client_credentials",
          clientAuthMethod: "client_secret_basic",
          tokenEndpoint: `${ORIGIN}/api/auth/oauth2/token`,
          issuer: `${ORIGIN}/api/auth`,
          resource: RESOURCES.agent,
          scope: AGENT_MACHINE_SCOPE,
          tokenLifetimeSeconds: 900,
        });
        expect(JSON.stringify(body)).not.toContain(secret);

        const replay = await post({ enrollmentGrant: secret });
        expect(replay.status).toBe(409);
        expect(await replay.text()).not.toContain("clientSecret");
      });

      it("refuses wrong media types, malformed JSON, extra keys, and oversized bodies", async () => {
        const { secret } = await grantFor("srv-a");
        expect(
          (await post({ enrollmentGrant: secret }, "text/plain")).status,
        ).toBe(415);
        expect((await post("{not json")).status).toBe(400);
        expect(
          (await post({ enrollmentGrant: secret, serverId: "srv-b" })).status,
        ).toBe(400);
        expect((await post("x".repeat(5000))).status).toBe(413);
        expect((await post({ enrollmentGrant: "egr_short" })).status).toBe(400);
      });

      it("lists grants and identities without hashes or secrets", async () => {
        const { secret } = await grantFor("srv-a");
        await redeem(secret);
        const grants = await listEnrollmentGrants(db, "srv-a");
        const identities = await listAgentIdentities(db, "srv-a");
        expect(JSON.stringify([grants, identities])).not.toMatch(
          /token_hash|tokenHash|attemptId|clientSecret/,
        );
        expect(identities).toHaveLength(1);
      });
    });
    describe("verifyAgentAccessToken against the provider", () => {
      const verify = (
        token: string,
        purpose: "handshake" | "session",
        audience = RESOURCES.agent,
      ) =>
        verifyAgentAccessToken(db, token, {
          issuer: `${ORIGIN}/api/auth`,
          audience,
          getJwks: () => auth.api.getJwks(),
          purpose,
        });
      const codeOf = async (promise: Promise<unknown>) => {
        try {
          await promise;
          return undefined;
        } catch (error) {
          return error instanceof AgentAuthError ? error.code : "other";
        }
      };

      it("maps a machine token to its server; a pending identity acts only for its handshake", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        const issued = await tokenFor(result.clientId, result.clientSecret);
        const token = issued.body.access_token as string;

        const handshake = await verify(token, "handshake");
        expect(handshake).toMatchObject({
          serverId: "srv-a",
          identityId: result.identityId,
          identityStatus: "pending",
          clientId: result.clientId,
        });
        expect(
          handshake.expiresAt - Math.floor(Date.now() / 1000),
        ).toBeLessThanOrEqual(AGENT_TOKEN_LIFETIME_SECONDS);
        expect(await codeOf(verify(token, "session"))).toBe(
          "identity_not_usable",
        );

        await setIdentityActive(result.identityId);
        expect((await verify(token, "session")).identityStatus).toBe("active");
      });

      it("refuses a machine token presented for another audience, and a tampered token", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        const token = (await tokenFor(result.clientId, result.clientSecret))
          .body.access_token as string;
        expect(await codeOf(verify(token, "session", RESOURCES.mcp))).toBe(
          "invalid_token",
        );
        expect(await codeOf(verify(`${token}x`, "session"))).toBe(
          "invalid_token",
        );
      });

      it("refuses a still-unexpired token as soon as its identity is revoked", async () => {
        const { secret } = await grantFor("srv-a");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        await setIdentityActive(result.identityId);
        const token = (await tokenFor(result.clientId, result.clientSecret))
          .body.access_token as string;
        expect((await verify(token, "session")).serverId).toBe("srv-a");

        await revokeAgentIdentity(db, {
          identityId: result.identityId,
          now: now(),
        });
        expect(await codeOf(verify(token, "session"))).toBe("client_disabled");
      });

      it("refuses a token whose server is disabled", async () => {
        const { secret } = await grantFor("srv-b");
        const result = await redeem(secret);
        if (!result.ok) throw new Error("unreachable");
        await setIdentityActive(result.identityId);
        const token = (await tokenFor(result.clientId, result.clientSecret))
          .body.access_token as string;
        await pool.query(
          `UPDATE server SET enabled = false WHERE id = 'srv-b'`,
        );
        expect(await codeOf(verify(token, "session"))).toBe("server_disabled");
      });

      it("refuses a valid machine client that has no identity mapping", async () => {
        await pool.query(
          `INSERT INTO oauth_client (id, client_id, client_secret, redirect_uris, grant_types, client_credentials_scopes, token_endpoint_auth_method, public, disabled)
         VALUES ('orphan', 'orphan-client', $1, '[]', '["client_credentials"]', $2, 'client_secret_basic', false, false)`,
          [
            hashClientSecret("fake-orphan-secret-0001"),
            JSON.stringify([AGENT_MACHINE_SCOPE]),
          ],
        );
        await pool.query(
          `INSERT INTO oauth_resource (id, identifier, name) VALUES ('agent-resource', $1, 'Blossom agent')
         ON CONFLICT DO NOTHING`,
          [RESOURCES.agent],
        );
        await pool.query(
          `INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES ('orphan-link', 'orphan-client', $1)`,
          [RESOURCES.agent],
        );
        const issued = await tokenFor(
          "orphan-client",
          "fake-orphan-secret-0001",
        );
        expect(issued.status).toBe(200);
        expect(
          await codeOf(verify(issued.body.access_token as string, "session")),
        ).toBe("unknown_client");
      });
    });
  },
);
