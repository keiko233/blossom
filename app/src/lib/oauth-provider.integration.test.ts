/**
 * Integration proof of the pinned Better Auth OAuth Provider (1.7.25) for the
 * agent identity design: per-server confidential clients on `client_credentials`,
 * exact resource and scope, short machine tokens, the MCP regression path, and
 * the negative cases that keep ordinary, dynamic and user-managed clients away
 * from the machine scope and resource.
 *
 * Runs the production options from `oauth-provider-config.ts` against a REAL,
 * DISPOSABLE PostgreSQL. Skipped unless BLOSSOM_TEST_PG_URL is set:
 *
 *   BLOSSOM_TEST_PG_URL  postgres://… on a loopback host, database name starting
 *                        with `blossom_disposable_`. The public schema is DROPPED
 *                        and rebuilt from app/drizzle/*.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "@blossom/database/server";
import { betterAuth } from "better-auth";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { admin } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

import {
  AGENT_MACHINE_SCOPE,
  AGENT_TOKEN_LIFETIME_SECONDS,
  createOAuthProviderOptions,
  getOAuthResourceIdentifiers,
} from "./oauth-provider-config";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const ORIGIN = "http://localhost:3000";
const ISSUER = `${ORIGIN}/api/auth`;
const RESOURCES = getOAuthResourceIdentifiers(ORIGIN);
const REDIRECT_URI = "https://client.example.test/callback";
const ADMIN_EMAIL = "proof-admin@example.test";
const ADMIN_PASSWORD = "fake-proof-password-0001";
const MACHINE_CLIENT_ID = "proof-agent-client";
const MACHINE_SECRET = "fake-proof-machine-secret-0001";

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

/** Same derivation the provider uses for stored client secrets (`storeClientSecret: "hashed"`). */
const hashClientSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("base64url");

type Json = Record<string, unknown>;

interface Harness {
  pool: Pool;
  auth: ReturnType<typeof buildAuth>;
  adminCookie: string;
}

function buildAuth(db: Database) {
  return betterAuth({
    baseURL: ORIGIN,
    secret: "fake-proof-secret-0123456789abcdefghijklmnopqrstuvwxyz",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [
      admin(),
      jwt({ jwt: { expirationTime: "15m" } }),
      oauthProvider(createOAuthProviderOptions(RESOURCES)),
    ],
  });
}

let h: Harness;

async function postForm(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const res = await h.auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields),
    }),
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Json,
  };
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await h.auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Json,
  };
}

function basic(clientId: string, secret: string) {
  return {
    authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
  };
}

/** Inserts a confidential, machine-only client exactly as enrollment will (hashed secret, agent link only). */
async function insertMachineClient(clientId: string, secret: string) {
  await h.pool.query(
    `INSERT INTO oauth_client (id, client_id, client_secret, redirect_uris, grant_types, client_credentials_scopes,
        token_endpoint_auth_method, public, disabled)
     VALUES ($1, $1, $2, '[]', '["client_credentials"]', $3, 'client_secret_basic', false, false)`,
    [clientId, hashClientSecret(secret), JSON.stringify([AGENT_MACHINE_SCOPE])],
  );
  await h.pool.query(
    `INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES ($1, $2, $3)`,
    [`link-${clientId}`, clientId, RESOURCES.agent],
  );
}

async function machineToken(extra: Record<string, string> = {}) {
  return postForm(
    "/oauth2/token",
    {
      grant_type: "client_credentials",
      resource: RESOURCES.agent,
      scope: AGENT_MACHINE_SCOPE,
      ...extra,
    },
    basic(MACHINE_CLIENT_ID, MACHINE_SECRET),
  );
}

async function decodeClaims(token: string, audience: string) {
  const jwks = await h.auth.api.getJwks();
  return verifyJwsAccessToken(token, {
    jwksFetch: async () => jwks,
    verifyOptions: { audience, issuer: ISSUER },
  }) as Promise<Json>;
}

/** Runs authorization code + PKCE for a public client, resuming consent as the admin. */
async function authorizationCodeToken(
  clientId: string,
  resource: string | undefined,
  scope: string,
) {
  const verifier = "fake-proof-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "fake-state",
    ...(resource ? { resource } : {}),
  });
  let res = await h.auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie: h.adminCookie },
      redirect: "manual",
    }),
  );
  let location = new URL(res.headers.get("location") ?? "", ORIGIN);
  if (location.pathname === "/auth/mcp-consent") {
    const consent = await postJson(
      "/oauth2/consent",
      { accept: true, oauth_query: location.search.slice(1) },
      { cookie: h.adminCookie },
    );
    if (typeof consent.body.url !== "string") {
      return { error: `consent ${consent.status}`, token: undefined };
    }
    location = new URL(consent.body.url, ORIGIN);
  }
  if (location.searchParams.has("error")) {
    return {
      error: location.searchParams.get("error") as string,
      token: undefined,
    };
  }
  const code = location.searchParams.get("code") ?? "";
  const token = await postForm("/oauth2/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    ...(resource ? { resource } : {}),
  });
  return { error: undefined, token: token.body };
}

describe.skipIf(!PG_URL)("Better Auth OAuth Provider 1.7.25 proof", () => {
  beforeAll(async () => {
    assertDisposable(PG_URL!);
    const pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
    );
    const db = drizzle({ client: pool });
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../../drizzle", import.meta.url),
      ),
    });
    const auth = buildAuth(db);
    const signup = await auth.api.signUpEmail({
      body: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        name: "Proof admin",
      },
      asResponse: true,
    });
    await pool.query(`UPDATE "user" SET role = 'admin' WHERE email = $1`, [
      ADMIN_EMAIL,
    ]);
    const adminCookie =
      (signup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    h = { pool, auth, adminCookie };
    await insertMachineClient(MACHINE_CLIENT_ID, MACHINE_SECRET);
  }, 120_000);

  afterAll(async () => {
    await h?.pool.end();
  });

  it("issues a machine token bound to the exact agent resource and scope, lived 15 minutes", async () => {
    const res = await machineToken();
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.scope).toBe(AGENT_MACHINE_SCOPE);
    const claims = await decodeClaims(
      res.body.access_token as string,
      RESOURCES.agent,
    );
    expect(claims.aud).toBe(RESOURCES.agent);
    expect(claims.scope).toBe(AGENT_MACHINE_SCOPE);
    expect(claims.client_id).toBe(MACHINE_CLIENT_ID);
    expect(claims.azp).toBe(MACHINE_CLIENT_ID);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(
      AGENT_TOKEN_LIFETIME_SECONDS,
    );
    // Recorded for the handoff: the machine token carries no user subject.
    expect(claims.sub).toBe(MACHINE_CLIENT_ID);
  });

  it("issues the same single machine scope when the request omits scope", async () => {
    const res = await postForm(
      "/oauth2/token",
      { grant_type: "client_credentials", resource: RESOURCES.agent },
      basic(MACHINE_CLIENT_ID, MACHINE_SECRET),
    );
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe(AGENT_MACHINE_SCOPE);
  });

  it("refuses to honor a machine token for the MCP audience", async () => {
    const res = await machineToken();
    await expect(
      decodeClaims(res.body.access_token as string, RESOURCES.mcp),
    ).rejects.toThrow();
  });

  it("refuses the machine client the MCP resource (not linked) and any other scope", async () => {
    const mcp = await machineToken({
      resource: RESOURCES.mcp,
      scope: AGENT_MACHINE_SCOPE,
    });
    expect(mcp.status).toBe(400);
    expect(mcp.body.error).toBe("invalid_target");
    const scope = await machineToken({ scope: "blossom:mcp:read" });
    expect(scope.status).toBe(400);
    expect(scope.body.error).toBe("invalid_scope");
  });

  it("refuses an unknown or wrong secret and a disabled machine client", async () => {
    const wrong = await postForm(
      "/oauth2/token",
      {
        grant_type: "client_credentials",
        resource: RESOURCES.agent,
        scope: AGENT_MACHINE_SCOPE,
      },
      basic(MACHINE_CLIENT_ID, "fake-wrong-secret"),
    );
    expect(wrong.status).toBe(401);
    await insertMachineClient(
      "proof-disabled-client",
      "fake-disabled-secret-0001",
    );
    await h.pool.query(
      `UPDATE oauth_client SET disabled = true WHERE client_id = 'proof-disabled-client'`,
    );
    const disabled = await postForm(
      "/oauth2/token",
      {
        grant_type: "client_credentials",
        resource: RESOURCES.agent,
        scope: AGENT_MACHINE_SCOPE,
      },
      basic("proof-disabled-client", "fake-disabled-secret-0001"),
    );
    expect(disabled.status).toBe(401);
    expect(disabled.body.error).toBe("invalid_client");
  });

  it("MCP regression: authorization code with the MCP resource still issues an MCP-audience token", async () => {
    const reg = await postJson("/oauth2/register", {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "blossom:mcp:read",
    });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const result = await authorizationCodeToken(
      clientId,
      RESOURCES.mcp,
      "blossom:mcp:read",
    );
    expect(result.error).toBeUndefined();
    expect(result.token).toHaveProperty("access_token");
    const access = result.token?.access_token as string;
    const claims = await decodeClaims(access, RESOURCES.mcp);
    expect(claims.aud).toBe(RESOURCES.mcp);
    expect(String(claims.scope)).not.toContain(AGENT_MACHINE_SCOPE);
    // The MCP lifetime is unchanged by the machine lifetime: still one day.
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60 * 60 * 24);
    await expect(decodeClaims(access, RESOURCES.agent)).rejects.toThrow();
  });

  it("dynamic registration cannot request the machine scope or the agent resource", async () => {
    const withScope = await postJson("/oauth2/register", {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: AGENT_MACHINE_SCOPE,
    });
    expect(withScope.status).not.toBe(201);
    const withResource = await postJson("/oauth2/register", {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "blossom:mcp:read",
      resources: [RESOURCES.agent],
    });
    expect(withResource.status).not.toBe(201);
    expect(withResource.body.error).toBe("invalid_target");
  });

  it("dynamic client_credentials registration without a session is refused", async () => {
    const res = await postJson("/oauth2/register", {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["client_credentials"],
      client_credentials_scopes: [AGENT_MACHINE_SCOPE],
    });
    expect(res.status).not.toBe(201);
  });

  it("user-managed clients cannot use the agent resource or the machine scope", async () => {
    const created = await postJson(
      "/oauth2/create-client",
      {
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["client_credentials"],
        client_credentials_scopes: [AGENT_MACHINE_SCOPE],
        resources: [RESOURCES.agent],
      },
      { cookie: h.adminCookie },
    );
    expect(created.status).toBe(201);
    const userClientId = created.body.client_id as string;
    const userSecret = created.body.client_secret as string;
    const row = await h.pool.query(
      `SELECT client_credentials_scopes FROM oauth_client WHERE client_id = $1`,
      [userClientId],
    );
    // Only the admin endpoint honors client_credentials_scopes; this path must drop them.
    expect(row.rows[0].client_credentials_scopes).toEqual([]);
    const token = await postForm(
      "/oauth2/token",
      {
        grant_type: "client_credentials",
        resource: RESOURCES.agent,
        scope: AGENT_MACHINE_SCOPE,
      },
      basic(userClientId, userSecret),
    );
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("unauthorized_client");
  });

  it("the admin link endpoint refuses to link the agent resource to an arbitrary client", async () => {
    await insertMachineClient("proof-probe-client", "fake-probe-secret-0001");
    const res = await h.auth.handler(
      new Request(
        `${ORIGIN}/api/auth/admin/oauth2/resources/${encodeURIComponent(RESOURCES.agent)}/clients/proof-probe-client`,
        {
          method: "POST",
          headers: { cookie: h.adminCookie, origin: ORIGIN },
        },
      ),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("a legacy MCP client registered before the upgrade is linked by the backfill; machine clients are not", async () => {
    await h.pool.query(
      `INSERT INTO oauth_client (id, client_id, redirect_uris, grant_types, token_endpoint_auth_method, public)
       VALUES ('legacy-mcp', 'legacy-mcp-client', $1, '["authorization_code","refresh_token"]', 'none', true)`,
      [JSON.stringify([REDIRECT_URI])],
    );
    const { linkNonAgentClientsToMcpResource } =
      await import("./oauth-resource-links");
    await linkNonAgentClientsToMcpResource(
      drizzle({ client: h.pool }),
      RESOURCES,
    );
    const links = await h.pool.query(
      `SELECT 1 FROM oauth_client_resource WHERE client_id = 'legacy-mcp-client' AND resource_id = $1`,
      [RESOURCES.mcp],
    );
    expect(links.rowCount).toBe(1);
    const agentLinks = await h.pool.query(
      `SELECT 1 FROM oauth_client_resource WHERE client_id = $1 AND resource_id = $2`,
      [MACHINE_CLIENT_ID, RESOURCES.mcp],
    );
    expect(agentLinks.rowCount).toBe(0);
    // The legacy client can now complete the MCP authorization code flow.
    const result = await authorizationCodeToken(
      "legacy-mcp-client",
      RESOURCES.mcp,
      "blossom:mcp:read",
    );
    expect(result.token).toHaveProperty("access_token");
  });
});
