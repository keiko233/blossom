import { eq } from "drizzle-orm";

import { db } from "@/db";
import { server } from "@/db/proxy-schema";
import { verifyAdminMetricsAuthority } from "@/lib/admin-metrics-authority";
import { acceptAdminMetrics } from "@/lib/admin-metrics-relay";
import type { AdminMetricsAcceptContext } from "@/lib/admin-metrics-relay-types";
import { getAuth } from "@/lib/auth";

export type AdminMetricsAuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>
>;

export interface AdminMetricsServerState {
  id: string;
  enabled: boolean;
  transportMode: string;
  wsConnectedAt: Date | null;
  wsSessionId: string | null;
  agentCapabilities: string[];
}

export interface AdminMetricsRouteDependencies {
  authenticate(request: Request): Promise<AdminMetricsAuthSession | null>;
  loadServer(serverId: string): Promise<AdminMetricsServerState | null>;
  accept(
    request: Request,
    context: AdminMetricsAcceptContext,
  ): Promise<Response>;
  verify(input: AdminMetricsAcceptContext): Promise<boolean>;
}

const defaultDependencies: AdminMetricsRouteDependencies = {
  async authenticate(request) {
    const session = await getAuth().api.getSession({
      headers: request.headers,
      query: { disableRefresh: true },
    });
    return session?.user.role === "admin" ? session : null;
  },
  async loadServer(serverId) {
    const [row] = await db
      .select({
        id: server.id,
        enabled: server.enabled,
        transportMode: server.transportMode,
        wsConnectedAt: server.wsConnectedAt,
        wsSessionId: server.wsSessionId,
        agentCapabilities: server.agentCapabilities,
      })
      .from(server)
      .where(eq(server.id, serverId));
    return row ?? null;
  },
  accept: acceptAdminMetrics,
  verify: verifyAdminMetricsAuthority,
};

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Rejects cross-site WebSocket attempts that would ride the admin cookie. */
export function isSameOriginWebSocket(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    return (
      (originUrl.protocol === "http:" || originUrl.protocol === "https:") &&
      originUrl.host === requestUrl.host
    );
  } catch {
    return false;
  }
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function availability(
  row: AdminMetricsServerState,
): { protocol: "v1" | "v2"; sessionId: string | null } | null {
  if (!row.enabled) return null;
  if (row.transportMode !== "ws" || !row.wsConnectedAt) return null;
  if (row.agentCapabilities.includes("telemetry-v2")) {
    return row.wsSessionId
      ? { protocol: "v2", sessionId: row.wsSessionId }
      : null;
  }
  if (row.agentCapabilities.includes("telemetry-v1")) {
    return { protocol: "v1", sessionId: null };
  }
  return null;
}

/**
 * Authenticated, same-origin admin live metric stream. A valid upgrade answers
 * 101 (Nitro via crossws hooks, Cloudflare through the Durable Object). The
 * relay then samples without browser input and rechecks authority while idle.
 */
export async function handleAdminMetricsRequest(
  request: Request,
  options: { serverId: string },
  dependencies: AdminMetricsRouteDependencies = defaultDependencies,
): Promise<Response> {
  if (!isWebSocketUpgrade(request)) {
    return plain(426, "WebSocket upgrade required");
  }
  if (!isSameOriginWebSocket(request)) {
    return plain(403, "Cross-origin WebSocket denied");
  }

  const auth = await dependencies.authenticate(request);
  if (!auth) {
    return plain(403, "Forbidden");
  }

  const row = await dependencies.loadServer(options.serverId);
  if (!row) {
    return plain(404, "Not found");
  }
  const selected = availability(row);
  if (!selected) {
    return Response.json(
      { error: "metrics_unavailable" },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const context: AdminMetricsAcceptContext = {
    serverId: row.id,
    connectedAt: row.wsConnectedAt!.toISOString(),
    sessionId: selected.sessionId,
    protocol: selected.protocol,
    adminSessionId: auth.session.id,
    userId: auth.user.id,
    verifyAuthority: () => dependencies.verify(context),
  };

  try {
    return await dependencies.accept(request, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`admin metrics upgrade failed: ${message}`);
    return plain(503, "Live metrics unavailable");
  }
}
