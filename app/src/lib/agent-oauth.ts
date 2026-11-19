import { verifyJwsAccessToken } from "better-auth/oauth2";
import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { agentIdentity } from "@/db/agent-identity-schema";
import { oauthClient, oauthClientResource } from "@/db/oauth-schema";
import { server } from "@/db/proxy-schema";

import { AGENT_MACHINE_SCOPE } from "./oauth-provider-config";

/**
 * Verifies agent machine access tokens and maps them to one server. Reusable by
 * the WebSocket handshake (follow-up) and any other agent surface. Every call
 * reads the authoritative state from the database, so revocation and disablement
 * take effect on the next check, without waiting for the token to expire.
 */

export type AgentAuthErrorCode =
  /** Signature, issuer, audience, or expiry failed, or the token is malformed. */
  | "invalid_token"
  /** A user or client token: a subject other than the machine client, or no client id. */
  | "not_machine_token"
  /** The token does not carry exactly the machine scope. */
  | "missing_scope"
  /** No identity is bound to the token's client. */
  | "unknown_client"
  | "client_disabled"
  /** The client is not linked to the agent resource (its link was removed). */
  | "resource_not_linked"
  | "server_disabled"
  /** Revoked or superseded, or pending where only an active identity may act. */
  | "identity_not_usable";

export class AgentAuthError extends Error {
  constructor(readonly code: AgentAuthErrorCode) {
    super(`agent authorization failed: ${code}`);
    this.name = "AgentAuthError";
  }
}

export type AgentTokenPurpose =
  /** The first WebSocket handshake of a pending identity. */
  | "handshake"
  /** Any later use: only an active identity may act. */
  | "session";

export interface AgentIdentityUse {
  serverId: string;
  identityId: string;
  generation: number;
  identityStatus: "pending" | "active";
  clientId: string;
  /** Epoch seconds from the verified `exp` claim. */
  expiresAt: number;
}

/**
 * Checks the claims of a machine token that signature verification has already
 * accepted. The audience must be exactly the agent resource, the scope exactly
 * the machine scope, and the subject (when present) the machine client itself.
 */
export function assertMachineAccessClaims(
  claims: Record<string, unknown>,
  expected: { audience: string; nowSeconds: number },
): { clientId: string; expiresAt: number } {
  const clientId =
    typeof claims.client_id === "string"
      ? claims.client_id
      : typeof claims.azp === "string"
        ? claims.azp
        : undefined;
  if (!clientId) {
    throw new AgentAuthError("not_machine_token");
  }
  if (
    (typeof claims.azp === "string" && claims.azp !== clientId) ||
    (typeof claims.client_id === "string" && claims.client_id !== clientId)
  ) {
    throw new AgentAuthError("not_machine_token");
  }
  if (claims.sub !== undefined && claims.sub !== clientId) {
    throw new AgentAuthError("not_machine_token");
  }

  const audience = claims.aud;
  const audienceMatches =
    audience === expected.audience ||
    (Array.isArray(audience) &&
      audience.length === 1 &&
      audience[0] === expected.audience);
  if (!audienceMatches) {
    throw new AgentAuthError("invalid_token");
  }

  const scopes =
    typeof claims.scope === "string"
      ? claims.scope.split(" ").filter(Boolean)
      : [];
  if (scopes.length !== 1 || scopes[0] !== AGENT_MACHINE_SCOPE) {
    throw new AgentAuthError("missing_scope");
  }

  if (typeof claims.exp !== "number" || claims.exp <= expected.nowSeconds) {
    throw new AgentAuthError("invalid_token");
  }
  return { clientId, expiresAt: claims.exp };
}

export interface AgentIdentityRow {
  identityId: string;
  serverId: string;
  generation: number;
  status: string;
  clientDisabled: boolean | null;
  serverEnabled: boolean;
}

/** Decides whether a bound identity may act for this purpose. Pure. */
export function decideAgentIdentityUse(
  row: AgentIdentityRow,
  input: { linked: boolean; purpose: AgentTokenPurpose },
): Omit<AgentIdentityUse, "clientId" | "expiresAt"> {
  if (row.clientDisabled) throw new AgentAuthError("client_disabled");
  if (!input.linked) throw new AgentAuthError("resource_not_linked");
  if (!row.serverEnabled) throw new AgentAuthError("server_disabled");
  const usable =
    row.status === "active" ||
    (row.status === "pending" && input.purpose === "handshake");
  if (!usable) throw new AgentAuthError("identity_not_usable");
  return {
    serverId: row.serverId,
    identityId: row.identityId,
    generation: row.generation,
    identityStatus: row.status === "active" ? "active" : "pending",
  };
}

export type JwksFetcher = Exclude<
  Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
  string
>;

/**
 * Verifies a bearer machine token for the agent resource and returns the server
 * it authorizes. Throws `AgentAuthError` with a code that callers may log.
 */
export async function verifyAgentAccessToken(
  db: Database,
  token: string,
  options: {
    issuer: string;
    audience: string;
    getJwks: JwksFetcher;
    purpose: AgentTokenPurpose;
    now?: Date;
  },
): Promise<AgentIdentityUse> {
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  let claims: Record<string, unknown>;
  try {
    claims = (await verifyJwsAccessToken(token, {
      jwksFetch: options.getJwks,
      verifyOptions: { audience: options.audience, issuer: options.issuer },
    })) as Record<string, unknown>;
  } catch {
    throw new AgentAuthError("invalid_token");
  }

  const { clientId, expiresAt } = assertMachineAccessClaims(claims, {
    audience: options.audience,
    nowSeconds,
  });

  const [row] = await db
    .select({
      identityId: agentIdentity.id,
      serverId: agentIdentity.serverId,
      generation: agentIdentity.generation,
      status: agentIdentity.status,
      clientDisabled: oauthClient.disabled,
      serverEnabled: server.enabled,
    })
    .from(agentIdentity)
    .innerJoin(
      oauthClient,
      eq(oauthClient.clientId, agentIdentity.oauthClientId),
    )
    .innerJoin(server, eq(server.id, agentIdentity.serverId))
    .where(eq(agentIdentity.oauthClientId, clientId))
    .limit(1);
  if (!row) {
    throw new AgentAuthError("unknown_client");
  }

  const [link] = await db
    .select({ id: oauthClientResource.id })
    .from(oauthClientResource)
    .where(
      and(
        eq(oauthClientResource.clientId, clientId),
        eq(oauthClientResource.resourceId, options.audience),
      ),
    )
    .limit(1);

  const use = decideAgentIdentityUse(row, {
    linked: Boolean(link),
    purpose: options.purpose,
  });
  return { ...use, clientId, expiresAt };
}
