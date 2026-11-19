import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { server } from "./proxy-schema.ts";

/**
 * Whether a host sample measures the machine itself or a container's cgroup
 * view. Charts break the series when this or `scopeKey` changes, because the
 * percentages then have a different denominator.
 */
export const SERVER_METRIC_SCOPES = ["host", "container"] as const;
export type ServerMetricScope = (typeof SERVER_METRIC_SCOPES)[number];

/**
 * One host-metric history bucket: the latest valid sample the control plane
 * received for `serverId` during the UTC minute `minute`. Written only by the
 * fenced ingestion helper in `@/query/server-metric-history`, never by a
 * browser request. Nullable measurement columns mean "not collected" and are
 * drawn as gaps rather than zeros. Network rates stay null until the agent
 * reports them. Rows expire after `SERVER_METRIC_RETENTION_DAYS`.
 */
export const serverMetricMinute = pgTable(
  "server_metric_minute",
  {
    // Cascade: history belongs to the server it describes.
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    // UTC minute of the control plane's receipt time, stored without a zone.
    minute: timestamp("minute").notNull(),
    scope: text("scope").$type<ServerMetricScope>().notNull(),
    // Canonical identity of the measurement scope (environment, cgroup
    // version and limits). Equal keys mean comparable percentages.
    scopeKey: text("scope_key").notNull(),
    cpuPercent: doublePrecision("cpu_percent"),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }),
    memoryTotalBytes: bigint("memory_total_bytes", { mode: "number" }),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }),
    networkTxBytesPerSecond: doublePrecision("network_tx_bytes_per_second"),
    networkRxBytesPerSecond: doublePrecision("network_rx_bytes_per_second"),
    receivedAt: timestamp("received_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.minute] }),
    // Serves the retention delete, which scans oldest minutes across servers.
    index("server_metric_minute_minute_idx").on(table.minute),
    check(
      "server_metric_minute_scope_check",
      sql`${table.scope} in ('host', 'container')`,
    ),
  ],
);

export type ServerMetricMinute = typeof serverMetricMinute.$inferSelect;
