import { getAuth } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { admitLogRelay } from "@/lib/logs-authority";
import type { LogAdmission } from "@/lib/logs-authority";
import type { AdminLogsAcceptContext } from "@/lib/logs-relay-types";
import { getRealtimeHub } from "@/lib/realtime-hub";
import { recordLogRelayOpen, type AdminLogsActor } from "@/query/log-audit";
import { createLogAuthorityStore } from "@/query/log-authority";

export interface AdminLogsAuthSession {
  session: { id: string; impersonatedBy?: string | null };
  user: { id: string; email: string | null };
}

export interface AdminLogsOpenAudit {
  serverId: string;
  sessionId: string;
  actor: AdminLogsActor;
  failed: boolean;
  error?: unknown;
}

export interface AdminLogsRouteDependencies {
  authenticate(request: Request): Promise<AdminLogsAuthSession | null>;
  admit(serverId: string): Promise<LogAdmission>;
  accept(request: Request, context: AdminLogsAcceptContext): Promise<Response>;
  recordOpen(input: AdminLogsOpenAudit): Promise<void>;
  newRelayId(): string;
  now(): Date;
}

/**
 * Reads the admin session without renewing it. A rolling refresh sets a
 * cookie on the upgrade response, and TanStack rebuilds that response to apply
 * it; workerd rejects a rebuilt 101 without its WebSocket. The session still
 * has to be live and an admin.
 */
export async function authenticateAdminLogsSession(
  request: Request,
): Promise<AdminLogsAuthSession | null> {
  const session = await getAuth().api.getSession({
    headers: request.headers,
    query: { disableRefresh: true },
  });
  return session?.user.role === "admin" ? session : null;
}

const defaultDependencies: AdminLogsRouteDependencies = {
  authenticate: authenticateAdminLogsSession,
  admit: (serverId) => admitLogRelay(createLogAuthorityStore(), serverId),
  accept: (request, context) =>
    getRealtimeHub().acceptAdminLogs(request, context),
  recordOpen: (input) => recordLogRelayOpen(input),
  newRelayId: () => crypto.randomUUID(),
  now: () => new Date(),
};

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Rejects cross-site WebSocket attempts that would ride the admin cookie. */
function isSameOriginWebSocket(request: Request): boolean {
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

/**
 * Authenticated browser-to-agent log upgrade. There is deliberately no server
 * function or MCP surface for log access: only a human admin session with a
 * same-origin WebSocket reaches an enrolled agent's retained buffer.
 */
export async function handleAdminLogsRequest(
  request: Request,
  options: { serverId: string },
  dependencies: AdminLogsRouteDependencies = defaultDependencies,
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

  const admission = await dependencies.admit(options.serverId);
  const actor: AdminLogsActor = {
    id: auth.user.id,
    email: auth.user.email,
    impersonatedBy: auth.session.impersonatedBy ?? null,
    ip: getClientIp(request),
    userAgent: request.headers.get("user-agent"),
  };
  const audit = (input: {
    sessionId: string;
    failed: boolean;
    error?: unknown;
  }) =>
    dependencies
      .recordOpen({
        serverId: options.serverId,
        sessionId: input.sessionId,
        actor,
        failed: input.failed,
        ...(input.error === undefined ? {} : { error: input.error }),
      })
      .catch((error: unknown) => {
        console.warn("admin log open audit failed", error);
      });

  if (!admission.ok) {
    await audit({ sessionId: "", failed: true, error: admission.error });
    if (admission.status === 404 || admission.error === "not_found") {
      return plain(404, "Not found");
    }
    if (admission.error === "forbidden") {
      return plain(403, "Forbidden");
    }
    return Response.json(
      { error: admission.error },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const context: AdminLogsAcceptContext = {
    serverId: options.serverId,
    serverName: admission.serverName,
    agentSessionId: admission.sessionId,
    authSessionId: auth.session.id,
    relayId: dependencies.newRelayId(),
    actor,
    startedAt: dependencies.now(),
  };

  try {
    const response = await dependencies.accept(request, context);
    const failed = response.status !== 101 && response.status !== 426;
    await audit({ sessionId: admission.sessionId, failed });
    return response;
  } catch (error) {
    await audit({ sessionId: admission.sessionId, failed: true, error });
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`admin log upgrade failed: ${message}`);
    return plain(503, "Log stream unavailable");
  }
}
