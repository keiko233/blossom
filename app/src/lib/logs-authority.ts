import {
  AGENT_WS_V2_LOGS_SEARCH_CAPABILITY,
  AGENT_WS_V2_LOGS_TAIL_CAPABILITY,
} from "@blossom/contracts/agent-ws-v2-logs";

import type { LogRelayRevocation } from "./logs-relay";

export type { LogRelayRevocation };

/**
 * Who may hold an admin log relay, decided from the database. Admission runs
 * once at the upgrade, after the cookie session has been read. Revalidation
 * runs for the life of the relay on both runtimes, so it reads only the
 * server row and the admin session by id and never needs the browser cookie.
 */

export interface LogAuthorityAdminSession {
  userId: string;
  role: string | null;
}

export interface LogAuthorityServer {
  id: string;
  name: string;
  enabled: boolean;
  transportMode: string;
  wsSessionId: string | null;
  agentCapabilities: readonly string[];
}

export interface LogAuthorityStore {
  /** The admin session with this id and an unexpired lease, or null. */
  loadAdminSession(
    authSessionId: string,
    now: Date,
  ): Promise<LogAuthorityAdminSession | null>;
  loadServer(serverId: string): Promise<LogAuthorityServer | null>;
}

/**
 * A relay needs at least one log capability. Each feature is then reported by
 * the agent: a request it cannot serve fails with `unsupported`, so the browser
 * can offer the tail and the search independently.
 */
export const LOG_RELAY_CAPABILITIES: readonly string[] = [
  AGENT_WS_V2_LOGS_TAIL_CAPABILITY,
  AGENT_WS_V2_LOGS_SEARCH_CAPABILITY,
];

export function hasLogCapability(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) =>
    LOG_RELAY_CAPABILITIES.includes(capability),
  );
}

export type LogAdmission =
  | { ok: true; serverName: string; sessionId: string }
  | { ok: false; status: 404 | 409; error: "not_found" | LogRelayRevocation };

/**
 * Checks the server a new relay would bind to. The relay binds to the server's
 * current agent session, so a connection without a live v2 session is refused.
 */
export async function admitLogRelay(
  store: LogAuthorityStore,
  serverId: string,
): Promise<LogAdmission> {
  const server = await store.loadServer(serverId);
  if (!server) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (!server.enabled) {
    return { ok: false, status: 409, error: "server_disabled" };
  }
  if (server.transportMode !== "ws" || !server.wsSessionId) {
    return { ok: false, status: 409, error: "offline" };
  }
  if (!hasLogCapability(server.agentCapabilities)) {
    return { ok: false, status: 409, error: "unsupported" };
  }
  return {
    ok: true,
    serverName: server.name,
    sessionId: server.wsSessionId,
  };
}

/**
 * Rechecks a live relay. Returns the reason it must end, or null when it may
 * continue. Checks run in order of how much they revoke: the admin, then the
 * server, then the agent session fence, then the capability.
 */
export async function revalidateLogRelay(
  store: LogAuthorityStore,
  input: {
    serverId: string;
    sessionId: string;
    authSessionId: string;
    now: Date;
  },
): Promise<LogRelayRevocation | null> {
  const admin = await store.loadAdminSession(input.authSessionId, input.now);
  if (!admin || admin.role !== "admin") {
    return "forbidden";
  }
  const server = await store.loadServer(input.serverId);
  if (!server) {
    return "forbidden";
  }
  if (!server.enabled) {
    return "server_disabled";
  }
  if (server.transportMode !== "ws" || !server.wsSessionId) {
    return "offline";
  }
  if (server.wsSessionId !== input.sessionId) {
    return "session_replaced";
  }
  if (!hasLogCapability(server.agentCapabilities)) {
    return "unsupported";
  }
  return null;
}
