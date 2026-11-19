import type {
  LogPolicyLevel,
  LogPolicySource,
} from "@blossom/contracts/log-policy";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { server } from "./proxy-schema";

/**
 * Desired and last acknowledged log-policy state per server and source.
 *
 * `revision` is scoped to the source and only moves forward. The server-wide
 * `server.logPolicyRevision` fences admin compare-and-swap writes and reaches
 * the agent through `welcome` / `agent.status.ack`; it never participates in
 * the configuration publish gate.
 *
 * `desiredBaseline` is the configured baseline and `desiredLevel` is the
 * currently requested level. A temporary override changes only the latter, so
 * expiry and Restore now return to the configured baseline instead of losing
 * it. `default` in either column means the installed or generated default.
 */
export const serverLogPolicy = pgTable(
  "server_log_policy",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    source: text("source").$type<LogPolicySource>().notNull(),
    desiredRevision: integer("desired_revision").default(0).notNull(),
    desiredBaseline: text("desired_baseline")
      .$type<LogPolicyLevel>()
      .default("default")
      .notNull(),
    desiredLevel: text("desired_level")
      .$type<LogPolicyLevel>()
      .default("default")
      .notNull(),
    desiredDeadline: timestamp("desired_deadline"),
    desiredUpdatedAt: timestamp("desired_updated_at").defaultNow().notNull(),
    desiredUpdatedBy: text("desired_updated_by"),

    effectiveRevision: integer("effective_revision"),
    effectiveLevel: text("effective_level").$type<LogPolicyLevel>(),
    effectiveBaseline: text("effective_baseline").$type<LogPolicyLevel>(),
    effectiveDeadline: timestamp("effective_deadline"),
    effectiveError: text("effective_error"),
    effectivePending: boolean("effective_pending").default(false).notNull(),
    effectiveAt: timestamp("effective_at"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.source] }),
    index("server_log_policy_server_idx").on(table.serverId),
  ],
);

export type ServerLogPolicy = typeof serverLogPolicy.$inferSelect;
export type NewServerLogPolicy = typeof serverLogPolicy.$inferInsert;
