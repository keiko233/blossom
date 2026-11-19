import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { negotiateAgentWsProtocol } from "@blossom/contracts/agent-ws-v2";

import type { Server } from "@/db/proxy-schema";
import { hashAgentToken, parseBearerToken } from "@/lib/agent-token";
import { getRealtimeHub } from "@/lib/realtime-hub";
import { buildAgentWelcome } from "@/orpc/proxy/agent-desired-state";
import { findAgentServerByTokenHash } from "@/query/agent";

import type { RealtimeHub } from "./realtime-hub-types";

const CROSSWS_HOOKS = Symbol.for("crossws.hooks");

type CrosswsResponse = Response & {
  crossws?: { upgrade: () => Response };
};

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export async function authenticateAgentWsRequest(
  request: Request,
  lookup: (
    tokenHash: string,
  ) => Promise<Server | null> = findAgentServerByTokenHash,
): Promise<Server | null> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token) {
    return null;
  }
  const server = await lookup(hashAgentToken(token));
  return server?.enabled ? server : null;
}

export interface AgentWsRouteDependencies {
  authenticate(request: Request): Promise<Server | null>;
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
  const server = await dependencies.authenticate(request);
  if (!server) {
    return rejectUpgrade(request, plainResponse(401, "Unauthorized"));
  }
  const negotiation = negotiateAgentWsProtocol(
    request.headers.get("sec-websocket-protocol"),
  );
  if (negotiation.protocol === "unsupported") {
    return rejectUpgrade(
      request,
      plainResponse(400, "Unsupported agent WebSocket subprotocol"),
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
      await dependencies.wakeCertificateIssuance();
      return await dependencies.hub.acceptAgentV2(request, server);
    }
    const welcome = await dependencies.buildWelcome(server);
    return await dependencies.hub.acceptAgent(request, server, welcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent websocket upgrade failed: ${message}`);
    return rejectUpgrade(request, plainResponse(503, "WebSocket unavailable"));
  }
}
