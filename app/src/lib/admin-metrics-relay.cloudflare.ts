import { env } from "cloudflare:workers";

import type { AdminMetricsAcceptContext } from "./admin-metrics-relay-types";

function requireAgentSessionBinding() {
  if (!env.AGENT_SESSION_DO) {
    throw new Error("AGENT_SESSION_DO binding is not configured");
  }
  return env.AGENT_SESSION_DO;
}

/**
 * Cloudflare keeps the agent socket and admin viewers in the same per-server
 * Durable Object, so the browser upgrade is forwarded there. The object owns
 * the coalesced sampler and the idle authority timer.
 */
export async function acceptAdminMetrics(
  request: Request,
  context: AdminMetricsAcceptContext,
): Promise<Response> {
  let binding: ReturnType<typeof requireAgentSessionBinding>;
  try {
    binding = requireAgentSessionBinding();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: "metrics_unavailable", message },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const stub = binding.get(binding.idFromName(context.serverId));

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set("x-blossom-metrics-connected-at", context.connectedAt);
  headers.set("x-blossom-metrics-protocol", context.protocol);
  headers.set("x-blossom-metrics-admin-session", context.adminSessionId);
  headers.set("x-blossom-metrics-user", context.userId);
  if (context.sessionId) {
    headers.set("x-blossom-metrics-session-id", context.sessionId);
  }

  try {
    return await stub.fetch(
      new Request(
        new URL(
          `/internal/admin-metrics/connect?serverId=${encodeURIComponent(context.serverId)}`,
          request.url,
        ),
        { method: "GET", headers },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`admin metrics Durable Object upgrade failed: ${message}`);
    return Response.json(
      { error: "metrics_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
