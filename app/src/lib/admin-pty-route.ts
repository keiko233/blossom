import { eq } from "drizzle-orm";

import { db } from "@/db";
import { server } from "@/db/proxy-schema";
import { getAuth } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { ptyAvailability } from "@/lib/pty-authorization";
import { clampPtyDimensions, isValidPtySessionId } from "@/lib/pty-protocol";
import { acceptAdminPty } from "@/lib/pty-relay";
import type { AdminPtyAcceptContext } from "@/lib/pty-relay-types";
import {
  type AdminPtyActor,
  type AdminPtySession,
  recordPtySessionOpen,
} from "@/query/pty-audit";

export type AdminPtyAuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>
>;

export interface AdminPtyServerState {
  id: string;
  name: string;
  enabled: boolean;
  transportMode: string;
  wsConnectedAt: Date | null;
  agentCapabilities: string[];
}

export interface AdminPtyRouteDependencies {
  authenticate(request: Request): Promise<AdminPtyAuthSession | null>;
  loadServer(serverId: string): Promise<AdminPtyServerState | null>;
  accept(request: Request, context: AdminPtyAcceptContext): Promise<Response>;
  recordOpen(
    session: AdminPtySession,
    outcome: { failed: boolean; error?: unknown },
  ): Promise<void>;
}

const defaultDependencies: AdminPtyRouteDependencies = {
  async authenticate(request) {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    return session?.user.role === "admin" ? session : null;
  },
  async loadServer(serverId) {
    const [row] = await db
      .select({
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        transportMode: server.transportMode,
        wsConnectedAt: server.wsConnectedAt,
        agentCapabilities: server.agentCapabilities,
      })
      .from(server)
      .where(eq(server.id, serverId));
    return row ?? null;
  },
  accept: acceptAdminPty,
  recordOpen: recordPtySessionOpen,
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

async function loadAuthorizedServer(
  request: Request,
  serverId: string,
  dependencies: AdminPtyRouteDependencies,
): Promise<
  | { ok: true; auth: AdminPtyAuthSession; row: AdminPtyServerState }
  | { ok: false; response: Response }
> {
  const auth = await dependencies.authenticate(request);
  if (!auth) {
    return { ok: false, response: plain(403, "Forbidden") };
  }
  const row = await dependencies.loadServer(serverId);
  if (!row) {
    return { ok: false, response: plain(404, "Not found") };
  }
  return { ok: true, auth, row };
}

/**
 * Same-origin readiness probe for the terminal panel. A failed WebSocket
 * handshake exposes no HTTP status to the browser, so the panel asks here
 * first to tell denied access apart from an unavailable agent.
 */
export async function handleAdminPtyStatus(
  request: Request,
  options: { serverId: string },
  dependencies: AdminPtyRouteDependencies = defaultDependencies,
): Promise<Response> {
  const loaded = await loadAuthorizedServer(
    request,
    options.serverId,
    dependencies,
  );
  if (!loaded.ok) {
    return loaded.response;
  }
  const unavailable = ptyAvailability(loaded.row);
  return Response.json(
    unavailable
      ? { available: false, reason: unavailable }
      : { available: true },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Authenticated browser-to-agent terminal upgrade. There is deliberately no
 * server function or MCP surface for starting a shell: only a human admin
 * session with a same-origin WebSocket can reach an enrolled agent.
 */
export async function handleAdminPtyRequest(
  request: Request,
  options: { serverId: string },
  dependencies: AdminPtyRouteDependencies = defaultDependencies,
): Promise<Response> {
  if (!isWebSocketUpgrade(request)) {
    return plain(426, "WebSocket upgrade required");
  }
  if (!isSameOriginWebSocket(request)) {
    return plain(403, "Cross-origin WebSocket denied");
  }

  const loaded = await loadAuthorizedServer(
    request,
    options.serverId,
    dependencies,
  );
  if (!loaded.ok) {
    return loaded.response;
  }
  const { auth, row } = loaded;
  const unavailable = ptyAvailability(row);
  if (unavailable) {
    return Response.json(
      { error: unavailable },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (!isValidPtySessionId(sessionId)) {
    return plain(400, "Invalid session id");
  }
  const dimensions = clampPtyDimensions(
    Number(url.searchParams.get("cols")),
    Number(url.searchParams.get("rows")),
  );

  const actor: AdminPtyActor = {
    id: auth.user.id,
    email: auth.user.email,
    impersonatedBy: auth.session.impersonatedBy ?? null,
    ip: getClientIp(request),
    userAgent: request.headers.get("user-agent"),
  };
  const session: AdminPtySession = {
    serverId: row.id,
    sessionId,
    cols: dimensions.cols,
    rows: dimensions.rows,
    startedAt: new Date(),
    actor,
  };

  try {
    const connectedAt = row.wsConnectedAt!.toISOString();
    const response = await dependencies.accept(request, {
      serverId: row.id,
      connectedAt,
      sessionId,
      cols: dimensions.cols,
      rows: dimensions.rows,
      session,
      authSessionId: auth.session.id,
      isAuthorized: async () => {
        const current = await loadAuthorizedServer(
          request,
          row.id,
          dependencies,
        );
        return (
          current.ok &&
          ptyAvailability(current.row) === null &&
          current.row.wsConnectedAt?.toISOString() === connectedAt
        );
      },
    });
    const failed = response.status !== 101 && response.status !== 426;
    await dependencies
      .recordOpen(session, { failed })
      .catch((error: unknown) => {
        console.warn("PTY open audit failed", error);
      });
    return response;
  } catch (error) {
    await dependencies
      .recordOpen(session, { failed: true, error })
      .catch((auditError: unknown) => {
        console.warn("PTY open audit failed", auditError);
      });
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`PTY upgrade failed: ${message}`);
    return plain(503, "Terminal unavailable");
  }
}
