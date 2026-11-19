import { type Database, db } from "@/db";
import { adminAuditLog } from "@/db/admin-audit-schema";
import { buildAdminAuditRow } from "@/lib/admin-audit";
import type { LogRelayAuditRecord } from "@/lib/logs-relay";

export interface AdminLogsActor {
  id: string;
  email: string | null;
  impersonatedBy?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Metadata-only rows for admin log access. Search text, record contents and
 * cursors are never passed to this module: the relay reducer only emits source,
 * level, time bounds, limits, outcomes and counts.
 */
function actorFields(actor: AdminLogsActor) {
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

/** Records that an operator opened a log relay on a server. */
export async function recordLogRelayOpen(
  input: {
    serverId: string;
    sessionId: string;
    actor: AdminLogsActor;
    failed: boolean;
    error?: unknown;
  },
  database?: Database,
): Promise<void> {
  const row = buildAdminAuditRow({
    id: crypto.randomUUID(),
    action: "server.logs_open",
    meta: { targetType: "server", targetId: () => input.serverId },
    input: { sessionId: input.sessionId },
    failed: input.failed,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...actorFields(input.actor),
    durationMs: 0,
  });
  await insert(row, database);
}

/** Writes one row for a relay audit record, such as a search or a close. */
export async function recordLogRelayAudit(
  input: {
    serverId: string;
    actor: AdminLogsActor;
    record: LogRelayAuditRecord;
  },
  database?: Database,
): Promise<void> {
  const { record } = input;
  const metadata = (() => {
    switch (record.action) {
      case "server.logs_subscribe":
        return undefined;
      case "server.logs_close":
        return {
          reason: record.reason,
          droppedBatches: record.droppedBatches,
          droppedRecords: record.droppedRecords,
        };
      case "server.logs_search":
        return {
          outcome: record.outcome,
          durationMs: record.durationMs,
          ...(record.matches === undefined ? {} : { matches: record.matches }),
          ...(record.coverageGap === undefined
            ? {}
            : { coverageGap: record.coverageGap }),
        };
      case "server.logs_context":
        return { outcome: record.outcome, durationMs: record.durationMs };
    }
  })();
  const row = buildAdminAuditRow({
    id: crypto.randomUUID(),
    action: record.action,
    meta: {
      targetType: "server",
      targetId: () => input.serverId,
      metadata: () => metadata,
    },
    input: "input" in record ? record.input : {},
    failed: record.failed,
    ...actorFields(input.actor),
    durationMs: "durationMs" in record ? record.durationMs : 0,
  });
  await insert(row, database);
}
