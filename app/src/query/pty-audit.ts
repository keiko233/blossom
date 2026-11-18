import type { AgentWsPtyExitReason } from "@blossom/contracts/agent-ws";

import { type Database, db } from "@/db";
import { adminAuditLog } from "@/db/admin-audit-schema";
import { buildAdminAuditRow } from "@/lib/admin-audit";

export interface AdminPtyActor {
  id: string;
  email: string | null;
  impersonatedBy?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AdminPtySession {
  serverId: string;
  sessionId: string;
  cols: number;
  rows: number;
  startedAt: Date;
  actor: AdminPtyActor;
}

export interface AdminPtyClose {
  session: AdminPtySession;
  reason: AgentWsPtyExitReason | "browser_closed";
  code?: number;
  signal?: string;
  closedAt?: Date;
}

function actorFields(actor: AdminPtyActor) {
  return {
    actor: { id: actor.id, email: actor.email },
    impersonatedBy: actor.impersonatedBy ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

async function insert(
  row: ReturnType<typeof buildAdminAuditRow>,
  database?: Database,
): Promise<void> {
  await (database ?? db).insert(adminAuditLog).values(row);
}

/**
 * The open row records who opened which server's terminal and its geometry.
 * Terminal bytes and commands are never passed to this module.
 */
export async function recordPtySessionOpen(
  session: AdminPtySession,
  outcome: { failed: boolean; error?: unknown },
  database?: Database,
): Promise<void> {
  const row = buildAdminAuditRow({
    id: crypto.randomUUID(),
    action: "server.pty_open",
    meta: { targetType: "server", targetId: () => session.serverId },
    input: {
      sessionId: session.sessionId,
      cols: session.cols,
      rows: session.rows,
    },
    failed: outcome.failed,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...actorFields(session.actor),
    durationMs: Date.now() - session.startedAt.getTime(),
  });
  await insert(row, database);
}

/** The close row records lifecycle metadata only, never terminal contents. */
export async function recordPtySessionClose(
  close: AdminPtyClose,
  database?: Database,
): Promise<void> {
  const closedAt = close.closedAt ?? new Date();
  const row = buildAdminAuditRow({
    id: crypto.randomUUID(),
    action: "server.pty_close",
    meta: {
      targetType: "server",
      targetId: () => close.session.serverId,
      metadata: () => ({
        reason: close.reason,
        ...(close.code === undefined ? {} : { code: close.code }),
        ...(close.signal === undefined ? {} : { signal: close.signal }),
      }),
    },
    input: { sessionId: close.session.sessionId },
    failed: false,
    ...actorFields(close.session.actor),
    durationMs: closedAt.getTime() - close.session.startedAt.getTime(),
  });
  await insert(row, database);
}
