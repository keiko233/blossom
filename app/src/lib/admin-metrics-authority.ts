import { and, eq, gt } from "drizzle-orm";

import { type Database, db } from "@/db";
import { session, user } from "@/db/auth-schema";
import { server } from "@/db/proxy-schema";

export interface AdminMetricsAuthority {
  serverId: string;
  connectedAt: string;
  sessionId: string | null;
  adminSessionId: string;
  userId: string;
}

/**
 * Re-checks an idle admin metric stream. The browser sends nothing while it
 * watches, so authorization, the admin session, server enablement, and the
 * exact agent session are revalidated on a timer rather than on user input.
 */
export async function verifyAdminMetricsAuthority(
  authority: AdminMetricsAuthority,
  database: Database = db,
): Promise<boolean> {
  const [row] = await database
    .select({
      enabled: server.enabled,
      transportMode: server.transportMode,
      wsSessionId: server.wsSessionId,
      agentCapabilities: server.agentCapabilities,
      sessionId: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      role: user.role,
      banned: user.banned,
    })
    .from(server)
    .innerJoin(session, eq(session.id, authority.adminSessionId))
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(server.id, authority.serverId),
        eq(server.wsConnectedAt, new Date(authority.connectedAt)),
        eq(session.userId, authority.userId),
        gt(session.expiresAt, new Date()),
      ),
    );

  if (!row || row.role !== "admin" || row.banned === true) {
    return false;
  }
  if (!row.enabled || row.transportMode !== "ws") {
    return false;
  }
  if (authority.sessionId !== null && authority.sessionId !== row.wsSessionId) {
    return false;
  }
  return (
    row.agentCapabilities.includes("telemetry-v2") ||
    row.agentCapabilities.includes("telemetry-v1")
  );
}
