import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { JsonValue } from "@/orpc/proxy/schema";

import { user } from "./auth-schema.ts";

/**
 * Subject types that produce access logs. Extend as new scenarios integrate
 * (e.g. "agent_pull", "auth_login").
 */
export type AccessLogSubjectType = "subscription";

/**
 * Generic, polymorphic access log. No FK on subjectId by design: subjects may be
 * deleted while their audit trail must survive.
 */
export const accessLog = pgTable(
  "access_log",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").$type<AccessLogSubjectType>().notNull(),
    subjectId: text("subject_id").notNull(),
    // Denormalized for per-user views; survives subject deletion.
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    clientName: text("client_name"),
    clientVersion: text("client_version"),
    metadata: jsonb("metadata").$type<Record<string, JsonValue>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("access_log_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
    index("access_log_user_idx").on(table.userId, table.createdAt),
  ],
);

export type AccessLog = typeof accessLog.$inferSelect;
export type NewAccessLog = typeof accessLog.$inferInsert;
