import { PTY_CAPABILITY } from "./pty-protocol";

export interface PtyServerRecord {
  enabled: boolean;
  transportMode: string;
  wsConnectedAt: Date | null;
  agentCapabilities: string[];
}

export type PtyUnavailableReason = "disabled" | "offline" | "unsupported";

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
  if (!row.agentCapabilities.includes(PTY_CAPABILITY)) {
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
  /** The agent connection the shell is attached to (`wsConnectedAt`, ISO). */
  serverConnectedAt: string;
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
    record.server.wsConnectedAt?.toISOString() === expected.serverConnectedAt
  );
}
