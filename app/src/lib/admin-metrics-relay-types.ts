export interface AdminMetricsAcceptContext {
  serverId: string;
  connectedAt: string;
  /** Exact v2 session fence, or null when the agent speaks v1. */
  sessionId: string | null;
  protocol: "v1" | "v2";
  adminSessionId: string;
  userId: string;
  /**
   * Re-checks the admin session, server enablement, capability and exact agent
   * session. Called on a timer so an idle viewer is disconnected when
   * authority is revoked.
   */
  verifyAuthority(): Promise<boolean>;
}
