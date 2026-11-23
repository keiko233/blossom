import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { negotiateAgentWsProtocol } from "@blossom/contracts/agent-ws-v2";

import { db } from "@/db";
import type { Server } from "@/db/proxy-schema";
import {
  AgentAuthError,
  verifyAgentAccessToken,
  type AgentIdentityUse,
  type AgentTokenPurpose,
} from "@/lib/agent-oauth";
import { authenticateStaticAgentToken } from "@/lib/agent-static-auth";
import { parseBearerToken } from "@/lib/agent-token";
import { getServerEnv } from "@/lib/env";
import { ManagedNetworkingRequiresV2Error } from "@/lib/managed-compile-error";
import { getOAuthResourceIdentifiers } from "@/lib/oauth-provider-config";
import { getRealtimeHub } from "@/lib/realtime-hub";
import { buildAgentWelcome } from "@/orpc/proxy/agent-desired-state";
import {
  type AgentSessionCredential,
  findAgentServerById,
  findAgentServerByTokenHash,
} from "@/query/agent";

import type { RealtimeHub } from "./realtime-hub-types";

const CROSSWS_HOOKS = Symbol.for("crossws.hooks");

type CrosswsResponse = Response & {
  crossws?: { upgrade: () => Response };
};

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export interface AgentWsAuthentication {
  server: Server;
  /** What authenticated the upgrade. Never raw bearer material. */
  credential: AgentSessionCredential;
}

/** Header the agent requires before it treats an authenticated 409 as a disable. */
export const AGENT_WS_DISABLED_STATE_HEADER = "x-blossom-agent-state";
export const AGENT_WS_DISABLED_STATE_VALUE = "disabled";

/**
 * Authenticates an agent WebSocket upgrade. Static tokens are checked first
 * with the existing hash lookup; an OAuth machine token is then verified
 * against the provider's issuer/JWKS and the exact agent audience and scope.
 * The server always comes from the mapped identity, never from the token.
 */
export async function authenticateAgentWsRequest(
  request: Request,
  lookup: (
    tokenHash: string,
  ) => Promise<Server | null> = findAgentServerByTokenHash,
  verifyOauth: (
    token: string,
    purpose: AgentTokenPurpose,
  ) => Promise<AgentIdentityUse | null> = verifyAgentOauthToken,
  loadServer: (
    serverId: string,
  ) => Promise<Server | null> = findAgentServerById,
): Promise<AgentWsAuthentication | null> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token) {
    return null;
  }
  const staticAuthentication = await authenticateStaticAgentToken(
    token,
    { allowDisabled: false },
    lookup,
  );
  if (staticAuthentication) {
    return {
      server: staticAuthentication.server,
      credential: {
        kind: "static",
        tokenHash: staticAuthentication.tokenHash,
      },
    };
  }

  const identity = await verifyOauth(token, "handshake").catch(
    (error: unknown) => {
      if (error instanceof AgentAuthError) {
        return null;
      }
      throw error;
    },
  );
  if (!identity) {
    return null;
  }
  const server = await loadServer(identity.serverId);
  if (!server?.enabled) {
    return null;
  }
  return {
    server,
    credential: {
      kind: "oauth",
      identityId: identity.identityId,
      generation: identity.generation,
      clientId: identity.clientId,
      expiresAt: identity.expiresAt,
      identityStatus: identity.identityStatus,
    },
  };
}

/**
 * Recognizes only a still-valid credential whose server is disabled. This is
 * a narrow disablement signal, not a session: it starts no session, updates no
 * fence, and returns no configuration. Invalid, revoked, expired, pending, or
 * client-disabled credentials remain ordinary authentication failures.
 */
export async function authenticateDisabledAgentWsRequest(
  request: Request,
  lookup: (
    tokenHash: string,
  ) => Promise<Server | null> = findAgentServerByTokenHash,
  verifyOauth: (
    token: string,
    purpose: AgentTokenPurpose,
  ) => Promise<AgentIdentityUse | null> = verifyAgentOauthToken,
  loadServer: (
    serverId: string,
  ) => Promise<Server | null> = findAgentServerById,
): Promise<AgentWsAuthentication | null> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token) {
    return null;
  }
  const staticAuthentication = await authenticateStaticAgentToken(
    token,
    { allowDisabled: true },
    lookup,
  );
  if (staticAuthentication) {
    return staticAuthentication.server.enabled
      ? null
      : {
          server: staticAuthentication.server,
          credential: {
            kind: "static",
            tokenHash: staticAuthentication.tokenHash,
          },
        };
  }

  const identity = await verifyOauth(token, "status").catch(
    (error: unknown) => {
      if (error instanceof AgentAuthError) {
        return null;
      }
      throw error;
    },
  );
  if (!identity || identity.identityStatus !== "active") {
    return null;
  }
  const server = await loadServer(identity.serverId);
  if (!server || server.enabled) {
    return null;
  }
  return {
    server,
    credential: {
      kind: "oauth",
      identityId: identity.identityId,
      generation: identity.generation,
      clientId: identity.clientId,
      expiresAt: identity.expiresAt,
      identityStatus: identity.identityStatus,
    },
  };
}

async function verifyAgentOauthToken(
  token: string,
  purpose: AgentTokenPurpose,
): Promise<AgentIdentityUse | null> {
  const origin = getServerEnv().BETTER_AUTH_URL.replace(/\/$/, "");
  const { getAuth } = await import("@/lib/auth");
  try {
    return await verifyAgentAccessToken(db, token, {
      issuer: `${origin}/api/auth`,
      audience: getOAuthResourceIdentifiers(origin).agent,
      getJwks: () => getAuth().api.getJwks(),
      purpose,
    });
  } catch (error) {
    if (error instanceof AgentAuthError) {
      return null;
    }
    throw error;
  }
}

export interface AgentWsRouteDependencies {
  authenticate(request: Request): Promise<AgentWsAuthentication | null>;
  /**
   * Recognizes a still-valid credential for a disabled server. The route uses
   * it only for a v2 upgrade after normal authentication failed.
   */
  authenticateDisabled(request: Request): Promise<AgentWsAuthentication | null>;
  buildWelcome(server: Server): Promise<AgentWsWelcomePayload>;
  /**
   * Advances the global certificate issuer on each v2 upgrade. It runs in the
   * request context, which a Durable Object message does not have, and it
   * replaces the wake-up a v1 config poll performs.
   */
  wakeCertificateIssuance(): Promise<void>;
  hub: Pick<RealtimeHub, "acceptAgent" | "acceptAgentV2">;
}

const defaultDependencies: AgentWsRouteDependencies = {
  authenticate: authenticateAgentWsRequest,
  authenticateDisabled: authenticateDisabledAgentWsRequest,
  buildWelcome: buildAgentWelcome,
  wakeCertificateIssuance: async () => {
    try {
      const { advanceCertificateIssuance } =
        await import("@/lib/certificate-issuance");
      await advanceCertificateIssuance();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`agent websocket certificate wake-up failed: ${message}`);
    }
  },
  hub: {
    acceptAgent: (...args) => getRealtimeHub().acceptAgent(...args),
    acceptAgentV2: (...args) => getRealtimeHub().acceptAgentV2(...args),
  },
};

function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function disabledServerResponse(): Response {
  return new Response("Server disabled", {
    status: 409,
    headers: {
      "cache-control": "no-store",
      [AGENT_WS_DISABLED_STATE_HEADER]: AGENT_WS_DISABLED_STATE_VALUE,
    },
  });
}

/**
 * Nitro's websocket resolver reads hooks, not the HTTP status, from the app
 * response. A rejected upgrade therefore has to reject again from its
 * `upgrade` hook; otherwise crossws accepts a connection the route denied.
 */
function rejectUpgrade(request: Request, response: Response): Response {
  const hooks = { upgrade: () => response };
  const upgraded = response as CrosswsResponse;
  upgraded.crossws = hooks;
  try {
    (request as unknown as Record<PropertyKey, unknown>)[CROSSWS_HOOKS] = hooks;
  } catch {
    // The response hook remains available when a runtime freezes requests.
  }
  return upgraded;
}

export async function handleAgentWsRequest(
  request: Request,
  dependencies: AgentWsRouteDependencies = defaultDependencies,
): Promise<Response> {
  const authentication = await dependencies.authenticate(request);
  if (!authentication) {
    const negotiation = negotiateAgentWsProtocol(
      request.headers.get("sec-websocket-protocol"),
    );
    if (negotiation.protocol === "v2" && isWebSocketUpgrade(request)) {
      const disabled = await dependencies.authenticateDisabled(request);
      if (disabled) {
        return rejectUpgrade(request, disabledServerResponse());
      }
    }
    return rejectUpgrade(request, plainResponse(401, "Unauthorized"));
  }
  const { server, credential } = authentication;
  const negotiation = negotiateAgentWsProtocol(
    request.headers.get("sec-websocket-protocol"),
  );
  if (negotiation.protocol === "unsupported") {
    return rejectUpgrade(
      request,
      plainResponse(400, "Unsupported agent WebSocket subprotocol"),
    );
  }
  if (credential.kind === "oauth" && negotiation.protocol !== "v2") {
    return rejectUpgrade(
      request,
      plainResponse(400, "OAuth requires the blossom-agent.v2 subprotocol"),
    );
  }
  if (!isWebSocketUpgrade(request)) {
    return rejectUpgrade(
      request,
      new Response("WebSocket upgrade required", {
        status: 426,
        headers: {
          "cache-control": "no-store",
          Connection: "Upgrade",
          Upgrade: "websocket",
        },
      }),
    );
  }

  try {
    if (negotiation.protocol === "v2") {
      const response = await dependencies.hub.acceptAgentV2(
        request,
        server,
        credential,
      );
      // Wake only once the socket is registered, so an `acme.issue` produced
      // by the sweep reaches this connection instead of being dropped.
      void dependencies.wakeCertificateIssuance().catch(() => undefined);
      return response;
    }
    const welcome = await dependencies.buildWelcome(server);
    return await dependencies.hub.acceptAgent(request, server, welcome);
  } catch (error) {
    if (error instanceof ManagedNetworkingRequiresV2Error) {
      return rejectUpgrade(request, plainResponse(409, error.message));
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent websocket upgrade failed: ${message}`);
    return rejectUpgrade(request, plainResponse(503, "WebSocket unavailable"));
  }
}
