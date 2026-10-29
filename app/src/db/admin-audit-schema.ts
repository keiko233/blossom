import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import type { AdminAuditStatus, AuditJson } from "@/lib/admin-audit";

import { user } from "./auth-schema";

/**
 * One row per admin mutation made through the web UI (the MCP tools have their
 * own `mcp_tool_audit`). The actor's email is snapshotted so the trail
 * survives deleting the account; `input` and `metadata` are stored redacted.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    actorEmail: text("actor_email"),
    // Stable dotted name, e.g. `user.ban` or `subscription.bulk_update`.
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    status: text("status").$type<AdminAuditStatus>().notNull(),
    input: jsonb("input").$type<AuditJson>(),
    // Extra context, e.g. the ids and outcome counts of a bulk operation.
    metadata: jsonb("metadata").$type<AuditJson>(),
    error: text("error"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    // Id of the admin when the session is an impersonation session.
    impersonatedBy: text("impersonated_by"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("admin_audit_log_created_idx").on(table.createdAt),
    index("admin_audit_log_actor_idx").on(table.actorUserId, table.createdAt),
    index("admin_audit_log_target_idx").on(table.targetType, table.targetId),
  ],
);

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;
