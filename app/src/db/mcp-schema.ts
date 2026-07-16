import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

export const mcpToolAudit = pgTable(
  "mcp_tool_audit",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    tool: text("tool").notNull(),
    redactedInput: text("redacted_input"),
    redactedOutput: text("redacted_output"),
    redactedError: text("redacted_error"),
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("mcp_tool_audit_actor_idx").on(table.actorUserId, table.createdAt),
    index("mcp_tool_audit_source_idx").on(table.source, table.createdAt),
    index("mcp_tool_audit_tool_idx").on(table.tool, table.createdAt),
  ],
);

export type McpToolAudit = typeof mcpToolAudit.$inferSelect;
export type NewMcpToolAudit = typeof mcpToolAudit.$inferInsert;
