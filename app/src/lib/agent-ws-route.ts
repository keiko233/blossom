import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";

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
  hub: RealtimeHub;
}

const defaultDependencies: AgentWsRouteDependencies = {
  authenticate: authenticateAgentWsRequest,
  buildWelcome: buildAgentWelcome,
  hub: {
    acceptAgent: (...args) => getRealtimeHub().acceptAgent(...args),
    notifyConfigChanged: (...args) =>
      getRealtimeHub().notifyConfigChanged(...args),
    notifyUpdateTrigger: (...args) =>
      getRealtimeHub().notifyUpdateTrigger(...args),
    notifyAcmeIssue: (...args) => getRealtimeHub().notifyAcmeIssue(...args),
    notifyAcmeDnsAck: (...args) => getRealtimeHub().notifyAcmeDnsAck(...args),
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
    const welcome = await dependencies.buildWelcome(server);
    return await dependencies.hub.acceptAgent(request, server, welcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent websocket upgrade failed: ${message}`);
    return rejectUpgrade(request, plainResponse(503, "WebSocket unavailable"));
  }
}
