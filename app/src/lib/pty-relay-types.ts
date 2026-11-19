import type { AdminPtySession } from "@/query/pty-audit";

export interface AdminPtyAcceptContext {
  serverId: string;
  connectedAt: string;
  /** Which agent envelope carries the terminal frames. */
  agentProtocol: "v1" | "v2";
  /** `wsSessionId`; required for v2 and ignored for v1. */
  agentSessionId: string | null;
  sessionId: string;
  cols: number;
  rows: number;
  session: AdminPtySession;
  /**
   * better-auth session row id. The Cloudflare Durable Object cannot see the
   * browser cookie, so it re-reads this row while the shell is open. It is the
   * row key, not the cookie or bearer token, and stays out of the audit rows.
   */
  authSessionId: string;
  /** Re-reads the admin session and agent connection for an open shell. */
  isAuthorized: () => Promise<boolean>;
}
