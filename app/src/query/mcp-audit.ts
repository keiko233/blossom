import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { mcpToolAudit, type NewMcpToolAudit } from "@/db/mcp-schema";

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
}

export interface McpToolAuditListParams {
  actorUserId?: string;
  source?: string;
  tool?: string;
  status?: ToolAuditStatus;
  limit?: number;
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

export async function listMcpToolAudits(
  params: McpToolAuditListParams = {},
): Promise<McpToolAuditEntry[]> {
  const conditions = [];
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

  const base = db
    .select()
    .from(mcpToolAudit)
    .orderBy(asc(mcpToolAudit.createdAt));

  const filtered =
    conditions.length > 0 ? base.where(and(...conditions)) : base;

  const limit = params.limit ?? 100;
  return (await filtered.limit(limit)) as McpToolAuditEntry[];
}
