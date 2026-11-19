import { and, eq, gt } from "drizzle-orm";

import { type Database, db } from "@/db";
import { session, user } from "@/db/auth-schema";
import { server } from "@/db/proxy-schema";
import type {
  LogAuthorityAdminSession,
  LogAuthorityServer,
  LogAuthorityStore,
} from "@/lib/logs-authority";

/** The database-backed authority for admin log relays, shared by both runtimes. */
export function createLogAuthorityStore(
  database: Database = db,
): LogAuthorityStore {
  return {
    async loadAdminSession(
      authSessionId: string,
      now: Date,
    ): Promise<LogAuthorityAdminSession | null> {
      const [row] = await database
        .select({ userId: session.userId, role: user.role })
        .from(session)
        .innerJoin(user, eq(user.id, session.userId))
        .where(and(eq(session.id, authSessionId), gt(session.expiresAt, now)))
        .limit(1);
      return row ?? null;
    },
    async loadServer(serverId: string): Promise<LogAuthorityServer | null> {
      const [row] = await database
        .select({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          transportMode: server.transportMode,
          wsSessionId: server.wsSessionId,
          agentCapabilities: server.agentCapabilities,
        })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1);
      return row ?? null;
    },
  };
}
