import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  type SQL,
} from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { mcpToolAudit, type NewMcpToolAudit } from "@/db/mcp-schema";
import { buildMcpAuditConditions } from "@/lib/admin-audit-filters";
import type { McpAuditFilter } from "@/orpc/audit/schema";

export type ToolAuditStatus = "success" | "error" | "timeout";

export interface AppendMcpToolAuditInput {
  actorUserId?: string;
  source: string;
  tool: string;
  redactedInput?: string;
  redactedOutput?: string;
  redactedError?: string;
  status: ToolAuditStatus;
  durationMs?: number;
}

export interface McpToolAuditEntry {
  id: string;
  actorUserId: string | null;
  source: string;
  tool: string;
  redactedInput: string | null;
  redactedOutput: string | null;
  redactedError: string | null;
  status: string;
  durationMs: number | null;
  createdAt: Date;
  /** The actor's current email; null for a deleted or unknown actor. */
  actorEmail: string | null;
}

export interface McpToolAuditListParams {
  actorUserId?: string;
  source?: string;
  tool?: string;
  status?: ToolAuditStatus;
  /** Richer filter used by the admin audit page (actor search, date range). */
  filter?: McpAuditFilter;
  limit?: number;
  offset?: number;
  /** Defaults to oldest first, as before. */
  order?: "asc" | "desc";
}

export async function appendMcpToolAudit(
  input: AppendMcpToolAuditInput,
): Promise<void> {
  const now = new Date();
  const row: NewMcpToolAudit = {
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId ?? null,
    source: input.source,
    tool: input.tool,
    redactedInput: input.redactedInput ?? null,
    redactedOutput: input.redactedOutput ?? null,
    redactedError: input.redactedError ?? null,
    status: input.status,
    durationMs: input.durationMs ?? null,
    createdAt: now,
  };

  await db.insert(mcpToolAudit).values(row);
}

function buildConditions(params: McpToolAuditListParams): SQL[] {
  const conditions: SQL[] = [];
  if (params.actorUserId) {
    conditions.push(eq(mcpToolAudit.actorUserId, params.actorUserId));
  }
  if (params.source) {
    conditions.push(eq(mcpToolAudit.source, params.source));
  }
  if (params.tool) {
    conditions.push(eq(mcpToolAudit.tool, params.tool));
  }
  if (params.status) {
    conditions.push(eq(mcpToolAudit.status, params.status));
  }
  if (params.filter) {
    conditions.push(...buildMcpAuditConditions(params.filter));
  }
  return conditions;
}

export async function listMcpToolAudits(
  params: McpToolAuditListParams = {},
): Promise<McpToolAuditEntry[]> {
  const direction = (params.order ?? "asc") === "asc" ? asc : desc;
  const conditions = buildConditions(params);

  const base = db
    .select({ ...getTableColumns(mcpToolAudit), actorEmail: user.email })
    .from(mcpToolAudit)
    .leftJoin(user, eq(mcpToolAudit.actorUserId, user.id))
    .orderBy(direction(mcpToolAudit.createdAt), direction(mcpToolAudit.id));

  const filtered =
    conditions.length > 0 ? base.where(and(...conditions)) : base;

  const limit = params.limit ?? 100;
  return (await filtered
    .limit(limit)
    .offset(params.offset ?? 0)) as McpToolAuditEntry[];
}

/** Total rows matching the same filters (ignores limit / offset / order). */
export async function countMcpToolAudits(
  params: McpToolAuditListParams = {},
): Promise<number> {
  const conditions = buildConditions(params);
  const base = db
    .select({ value: count() })
    .from(mcpToolAudit)
    .leftJoin(user, eq(mcpToolAudit.actorUserId, user.id));
  const [row] = await (conditions.length > 0
    ? base.where(and(...conditions))
    : base);
  return row?.value ?? 0;
}
