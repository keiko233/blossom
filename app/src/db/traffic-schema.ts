import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
