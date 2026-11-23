import handler from "@tanstack/react-start/server-entry";

import { getServerEnv } from "@/lib/env";
import { paraglideMiddleware } from "@/paraglide/server";

export { AgentSessionDO } from "@/durable-objects/agent-session";

const MAINTENANCE_PATHS = [
  "/api/maintenance/server-metrics",
  "/api/maintenance/managed-rollouts",
  "/api/maintenance/certificates",
] as const;

function shouldBypassParaglide(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return true;
  }
  return new URL(request.url).pathname === "/api/agent/ws";
}

/**
 * Cloudflare Cron Trigger entry point. Each sweep runs through the same
 * token-authenticated maintenance route an external scheduler would call, so
 * it executes inside a request context (the database handle is request
 * scoped) and shares one implementation. A failing sweep never blocks the
 * others.
 */
async function runMaintenanceSweeps(): Promise<void> {
  const token = getServerEnv().MAINTENANCE_TOKEN;
  if (!token) {
    console.warn("[scheduled] MAINTENANCE_TOKEN is unset; skipping sweeps");
    return;
  }
  const origin = getServerEnv().BETTER_AUTH_URL;
  for (const path of MAINTENANCE_PATHS) {
    try {
      const response = await handler.fetch(
        new Request(new URL(path, origin), {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      if (!response.ok) {
        console.warn(`[scheduled] ${path} responded ${response.status}`);
      }
    } catch (error) {
      console.error(`[scheduled] ${path} failed:`, error);
    }
  }
}

export default {
  fetch: (...args: Parameters<typeof handler.fetch>) =>
    shouldBypassParaglide(args[0])
      ? handler.fetch(...args)
      : paraglideMiddleware(args[0], () => handler.fetch(...args)),
  scheduled: (
    _controller: unknown,
    _env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) => {
    ctx.waitUntil(runMaintenanceSweeps());
  },
};
