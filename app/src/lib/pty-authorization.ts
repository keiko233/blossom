import { AGENT_WS_V2_PTY_CAPABILITY } from "@blossom/contracts/agent-ws-v2";

import { PTY_CAPABILITY } from "./pty-protocol";

export interface PtyServerRecord {
  enabled: boolean;
  transportMode: string;
  wsConnectedAt: Date | null;
  wsSessionId: string | null;
  agentCapabilities: string[];
}

export type PtyUnavailableReason = "disabled" | "offline" | "unsupported";
export type PtyProtocol = "v1" | "v2";

/**
 * Selects the frame envelope the agent expects. A v2 session advertises
 * `ws-v2` and `pty-v2`; v1 sessions advertise `pty-v1` and never `ws-v2`.
 */
export function ptyProtocol(row: PtyServerRecord): PtyProtocol | null {
  if (row.agentCapabilities.includes("ws-v2")) {
    return row.agentCapabilities.includes(AGENT_WS_V2_PTY_CAPABILITY)
      ? "v2"
      : null;
  }
  return row.agentCapabilities.includes(PTY_CAPABILITY) ? "v1" : null;
}

/** Why a server cannot host a terminal right now, or null when it can. */
export function ptyAvailability(
  row: PtyServerRecord,
): PtyUnavailableReason | null {
  if (!row.enabled) {
    return "disabled";
  }
  if (row.transportMode !== "ws" || !row.wsConnectedAt) {
    return "offline";
  }
  const protocol = ptyProtocol(row);
  if (protocol === null) {
    return "unsupported";
  }
  if (protocol === "v2" && !row.wsSessionId) {
    return "unsupported";
  }
  return null;
}

/** The rows a re-check reads for one open shell. Missing rows are null. */
export interface PtyAuthorizationRecord {
  /** Owner of the admin session row, or null when that row is gone. */
  sessionUserId: string | null;
  sessionExpiresAt: Date | null;
  role: string | null;
  server: PtyServerRecord | null;
}

export interface PtyAuthorizationExpectation {
  /** The admin the shell was opened for. */
  userId: string;
  /** The envelope selected when the shell opened. */
  protocol: PtyProtocol;
  /** The agent connection the shell is attached to (`wsConnectedAt`, ISO). */
  serverConnectedAt: string;
  /** The v2 session the shell is attached to (`wsSessionId`). */
  serverSessionId: string | null;
  now: Date;
}

/**
 * Mirrors the Node relay's re-check: the admin session is still live and still
 * belongs to the actor, the user is still an admin, and the server is still
 * enabled and advertising the PTY capability on the same agent connection.
 */
export function isPtyAuthorized(
  record: PtyAuthorizationRecord,
  expected: PtyAuthorizationExpectation,
): boolean {
  return (
    record.sessionUserId === expected.userId &&
    record.sessionExpiresAt !== null &&
    record.sessionExpiresAt.getTime() > expected.now.getTime() &&
    record.role === "admin" &&
    record.server !== null &&
    ptyAvailability(record.server) === null &&
    ptyProtocol(record.server) === expected.protocol &&
    (expected.protocol === "v2"
      ? Boolean(
          expected.serverSessionId &&
          record.server.wsSessionId === expected.serverSessionId,
        )
      : record.server.wsConnectedAt?.toISOString() ===
        expected.serverConnectedAt)
  );
}
