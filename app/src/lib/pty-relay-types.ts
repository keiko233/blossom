import type { AdminPtySession } from "@/query/pty-audit";

export interface AdminPtyAcceptContext {
  serverId: string;
  connectedAt: string;
  sessionId: string;
  cols: number;
  rows: number;
  session: AdminPtySession;
  /** Re-reads the admin session and agent connection for an open shell. */
  isAuthorized: () => Promise<boolean>;
}
