import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema.ts";
import { subscription } from "./plan-schema.ts";
import { node, server } from "./proxy-schema.ts";

/**
 * One agent traffic report entry: bytes a subscription consumed on a node over a
 * reporting window. Counters on `subscription.trafficUsedBytes` hold the running
 * total; these rows keep the per-node history for charts and audit. `userId` is
 * denormalized from the subscription for direct per-user queries. `serverId` is
 * denormalized from the agent's token-bearing server so per-server queries survive
 * node moves/deletes.
 */
export const trafficRecord = pgTable(
  "traffic_record",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscription.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Set null on node delete: usage history outlives the node.
    nodeId: text("node_id").references(() => node.id, {
      onDelete: "set null",
    }),
    // Denormalized from the agent's server; null when the server is later
    // deleted (FK is SET NULL on purpose: history must survive).
    serverId: text("server_id").references(() => server.id, {
      onDelete: "set null",
    }),
    uplinkBytes: bigint("uplink_bytes", { mode: "number" }).notNull(),
    downlinkBytes: bigint("downlink_bytes", { mode: "number" }).notNull(),
    // Reporting window as stated by the agent; optional because early agents may
    // only send deltas without window bounds.
    windowStartedAt: timestamp("window_started_at"),
    windowEndedAt: timestamp("window_ended_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Leads with the time range: serves unfiltered / plan-filtered analytics
    // queries (the other indexes lead with an entity column).
    index("traffic_record_created_idx").on(table.createdAt),
    index("traffic_record_subscription_idx").on(
      table.subscriptionId,
      table.createdAt,
    ),
    index("traffic_record_user_idx").on(table.userId, table.createdAt),
    index("traffic_record_node_idx").on(table.nodeId, table.createdAt),
    index("traffic_record_server_idx").on(table.serverId, table.createdAt),
  ],
);

export type TrafficRecord = typeof trafficRecord.$inferSelect;
export type NewTrafficRecord = typeof trafficRecord.$inferInsert;

/**
 * Idempotency ledger for agent traffic reports that carry a `reportId`. A row is
 * inserted in the same SQL statement that writes the history rows and bumps the
 * subscription counters, so "report applied" and "ledger row exists" are one
 * atomic fact on both database drivers. `(serverId, reportId)` is the identity:
 * ids are owned by the agent and only unique per server. `contentHash` lets a
 * replay with the same id but different content be rejected, and `accepted` /
 * `dropped` let a duplicate be answered exactly like the first delivery. Rows
 * are pruned after the retention window (see `TRAFFIC_REPORT_RETENTION_DAYS`
 * in `@/query/agent`); the agent discards pending reports well before that.
 */
export const trafficReport = pgTable(
  "traffic_report",
  {
    id: text("id").primaryKey(),
    // Cascade: the ledger only protects replays from that server's agent.
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    reportId: text("report_id").notNull(),
    contentHash: text("content_hash").notNull(),
    accepted: integer("accepted").notNull(),
    dropped: integer("dropped").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("traffic_report_server_report_unique").on(
      table.serverId,
      table.reportId,
    ),
    // Serves the retention prune (per server, oldest first).
    index("traffic_report_server_created_idx").on(
      table.serverId,
      table.createdAt,
    ),
  ],
);

export type TrafficReport = typeof trafficReport.$inferSelect;
