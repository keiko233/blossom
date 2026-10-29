import { toCsv } from "@/lib/csv";

export interface AdminAuditCsvRow {
  id: string;
  createdAt: Date;
  actorEmail: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  status: string;
  error: string | null;
  ip: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
  durationMs: number | null;
  input: unknown;
  metadata: unknown;
}

export const ADMIN_AUDIT_CSV_COLUMNS = [
  "id",
  "created_at",
  "actor_email",
  "actor_user_id",
  "action",
  "target_type",
  "target_id",
  "status",
  "error",
  "ip",
  "user_agent",
  "impersonated_by",
  "duration_ms",
  "input",
  "metadata",
] as const;

function jsonCell(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** CSV text for the admin audit export. Inputs are the already-redacted JSON. */
export function adminAuditToCsv(rows: readonly AdminAuditCsvRow[]): string {
  return toCsv(
    ADMIN_AUDIT_CSV_COLUMNS,
    rows.map((row) => [
      row.id,
      row.createdAt,
      row.actorEmail,
      row.actorUserId,
      row.action,
      row.targetType,
      row.targetId,
      row.status,
      row.error,
      row.ip,
      row.userAgent,
      row.impersonatedBy,
      row.durationMs,
      jsonCell(row.input),
      jsonCell(row.metadata),
    ]),
  );
}

export interface McpAuditCsvRow {
  id: string;
  createdAt: Date;
  actorEmail: string | null;
  actorUserId: string | null;
  source: string;
  tool: string;
  status: string;
  redactedInput: string | null;
  redactedError: string | null;
  durationMs: number | null;
}

export const MCP_AUDIT_CSV_COLUMNS = [
  "id",
  "created_at",
  "actor_email",
  "actor_user_id",
  "source",
  "tool",
  "status",
  "error",
  "duration_ms",
  "input",
] as const;

/** CSV text for the MCP tool audit export (input/error are stored redacted). */
export function mcpAuditToCsv(rows: readonly McpAuditCsvRow[]): string {
  return toCsv(
    MCP_AUDIT_CSV_COLUMNS,
    rows.map((row) => [
      row.id,
      row.createdAt,
      row.actorEmail,
      row.actorUserId,
      row.source,
      row.tool,
      row.status,
      row.redactedError,
      row.durationMs,
      row.redactedInput,
    ]),
  );
}
