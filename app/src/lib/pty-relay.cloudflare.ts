import { env } from "cloudflare:workers";

import type { AdminPtyAcceptContext } from "./pty-relay-types";

function requireAgentSessionBinding() {
  if (!env.AGENT_SESSION_DO) {
    throw new Error("AGENT_SESSION_DO binding is not configured");
  }
  return env.AGENT_SESSION_DO;
}

/**
 * Cloudflare keeps the agent and browser sockets in the same per-server
 * Durable Object, so the browser upgrade is forwarded there instead of being
 * handled by the stateless Worker.
 */
export async function acceptAdminPty(
  request: Request,
  context: AdminPtyAcceptContext,
): Promise<Response> {
  let binding: ReturnType<typeof requireAgentSessionBinding>;
  try {
    binding = requireAgentSessionBinding();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: "terminal_unavailable", message },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const stub = binding.get(binding.idFromName(context.serverId));

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set("x-blossom-pty-session", context.sessionId);
  headers.set("x-blossom-pty-auth-session", context.authSessionId);
  headers.set("x-blossom-pty-connected-at", context.connectedAt);
  headers.set("x-blossom-pty-protocol", context.agentProtocol);
  if (context.agentSessionId) {
    headers.set("x-blossom-pty-agent-session", context.agentSessionId);
  }
  headers.set("x-blossom-pty-cols", String(context.cols));
  headers.set("x-blossom-pty-rows", String(context.rows));
  headers.set(
    "x-blossom-pty-actor",
    encodeURIComponent(JSON.stringify(context.session.actor)),
  );
  headers.set(
    "x-blossom-pty-started-at",
    context.session.startedAt.toISOString(),
  );

  try {
    return await stub.fetch(
      new Request(
        new URL(
          `/internal/pty/connect?serverId=${encodeURIComponent(context.serverId)}`,
          request.url,
        ),
        { method: "GET", headers },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`PTY Durable Object upgrade failed: ${message}`);
    return Response.json(
      { error: "terminal_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
