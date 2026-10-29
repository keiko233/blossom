import { toCsv } from "@/lib/csv";
import { sharePercent, type TrafficBucket } from "@/lib/traffic-analytics";
import type { TrafficDimension } from "@/orpc/traffic/schema";

/** One row of a breakdown table. `id` is null for deleted servers / nodes. */
export interface TrafficBreakdownRow {
  id: string | null;
  name: string | null;
  /** Only set for the user dimension. */
  email: string | null;
  uplink: number;
  downlink: number;
  total: number;
}

export const TRAFFIC_SERIES_CSV_COLUMNS = [
  "bucket_start_utc",
  "uplink_bytes",
  "downlink_bytes",
  "total_bytes",
] as const;

/** Time series, one line per (zero-filled) bucket, UTC ISO-8601 starts. */
export function trafficSeriesToCsv(buckets: readonly TrafficBucket[]): string {
  return toCsv(
    TRAFFIC_SERIES_CSV_COLUMNS,
    buckets.map((bucket) => [
      new Date(bucket.start).toISOString(),
      bucket.uplink,
      bucket.downlink,
      bucket.uplink + bucket.downlink,
    ]),
  );
}

export function trafficBreakdownCsvColumns(
  dimension: TrafficDimension,
): string[] {
  return [
    `${dimension}_id`,
    "name",
    ...(dimension === "user" ? ["email"] : []),
    "uplink_bytes",
    "downlink_bytes",
    "total_bytes",
    "share_percent",
  ];
}

/** Breakdown rows with their share of `grandTotal` (2 decimals). */
export function trafficBreakdownToCsv(
  dimension: TrafficDimension,
  rows: readonly TrafficBreakdownRow[],
  grandTotal: number,
): string {
  return toCsv(
    trafficBreakdownCsvColumns(dimension),
    rows.map((row) => [
      row.id,
      row.name,
      ...(dimension === "user" ? [row.email] : []),
      row.uplink,
      row.downlink,
      row.total,
      Math.round(sharePercent(row.total, grandTotal) * 100) / 100,
    ]),
  );
}
