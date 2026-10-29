/**
 * Pure range / bucket math of the admin traffic analytics. Everything is in
 * UTC: buckets are `date_trunc('hour' | 'day', created_at)` on the stored UTC
 * timestamps, so server and client agree on bucket boundaries no matter the
 * viewer's time zone (the UI labels the axis as UTC).
 */

export type TrafficGranularity = "hour" | "day";

export const TRAFFIC_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type TrafficPreset = (typeof TRAFFIC_PRESETS)[number];
export const DEFAULT_TRAFFIC_PRESET: TrafficPreset = "30d";

/** Longest range the server accepts. */
export const TRAFFIC_MAX_RANGE_DAYS = 366;
/** Ranges up to this many hours are bucketed by hour, longer ones by day. */
export const TRAFFIC_HOURLY_MAX_HOURS = 48;

export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

const PRESET_DAYS: Record<Exclude<TrafficPreset, "24h">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** A half-open range `[from, to)` in epoch milliseconds. */
export interface TrafficRange {
  from: number;
  to: number;
}

/** One zero-filled time bucket; `start` is the UTC bucket start in epoch ms. */
export interface TrafficBucket {
  start: number;
  uplink: number;
  downlink: number;
}

const unitMs = (granularity: TrafficGranularity) =>
  granularity === "hour" ? MS_PER_HOUR : MS_PER_DAY;

/** Start of the UTC hour / day containing `ms` (the epoch is UTC-aligned). */
export function floorToBucket(
  ms: number,
  granularity: TrafficGranularity,
): number {
  const unit = unitMs(granularity);
  return Math.floor(ms / unit) * unit;
}

/** Hourly buckets for ranges of at most 48 hours, daily buckets beyond. */
export function getTrafficGranularity(range: TrafficRange): TrafficGranularity {
  return range.to - range.from <= TRAFFIC_HOURLY_MAX_HOURS * MS_PER_HOUR
    ? "hour"
    : "day";
}

/**
 * The range a preset stands for at `nowMs`: the last N hours/days, aligned to
 * bucket boundaries and including the current (partial) hour/day.
 */
export function presetToRange(
  preset: TrafficPreset,
  nowMs: number,
): TrafficRange {
  if (preset === "24h") {
    const to = floorToBucket(nowMs, "hour") + MS_PER_HOUR;
    return { from: to - 24 * MS_PER_HOUR, to };
  }
  const to = floorToBucket(nowMs, "day") + MS_PER_DAY;
  return { from: to - PRESET_DAYS[preset] * MS_PER_DAY, to };
}

/** UTC midnight of a `YYYY-MM-DD` day, or undefined if it is not a real day. */
export function parseUtcDay(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Rejects overflow like 2026-02-31, which `Date.UTC` would roll over.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? ms
    : undefined;
}

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function toUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Custom day range, both ends inclusive and in UTC. A missing end defaults to
 * today / 29 days before `to`; an inverted range collapses to one day and a
 * range over the cap keeps its end and drops the oldest days.
 */
export function daysToRange(
  fromDay: string | undefined,
  toDay: string | undefined,
  nowMs: number,
): TrafficRange | undefined {
  const start = parseUtcDay(fromDay);
  const end = parseUtcDay(toDay);
  if (start === undefined && end === undefined) return undefined;
  const lastDay = end ?? floorToBucket(nowMs, "day");
  const firstDay = Math.min(start ?? lastDay - 29 * MS_PER_DAY, lastDay);
  const to = lastDay + MS_PER_DAY;
  return {
    from: Math.max(firstDay, to - TRAFFIC_MAX_RANGE_DAYS * MS_PER_DAY),
    to,
  };
}

/** The equal-length range immediately before `range`. */
export function previousRange(range: TrafficRange): TrafficRange {
  return { from: range.from - (range.to - range.from), to: range.from };
}

/** Start instants of every bucket touching `[from, to)`. */
export function bucketStarts(
  range: TrafficRange,
  granularity: TrafficGranularity,
): number[] {
  const unit = unitMs(granularity);
  const starts: number[] = [];
  for (
    let at = floorToBucket(range.from, granularity);
    at < range.to;
    at += unit
  ) {
    starts.push(at);
  }
  return starts;
}

/**
 * Lays sparse SQL rows onto the full bucket grid so an empty bucket is a real
 * zero (a gap), never skipped or interpolated by the chart.
 */
export function zeroFillBuckets(
  rows: readonly TrafficBucket[],
  range: TrafficRange,
  granularity: TrafficGranularity,
): TrafficBucket[] {
  const byStart = new Map(rows.map((row) => [row.start, row]));
  return bucketStarts(range, granularity).map(
    (start) => byStart.get(start) ?? { start, uplink: 0, downlink: 0 },
  );
}

/**
 * Relative change in percent, or null when there is no baseline (previous is
 * zero), so the UI can show "new" / nothing instead of Infinity.
 */
export function changePercent(
  current: number,
  previous: number,
): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** `part` as a percentage of `whole`; 0 for an empty whole. */
export function sharePercent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * UTC label of a bucket. `axis` is compact; `full` is for tooltips and tables
 * and always carries the date (and the hour for hourly buckets).
 */
export function formatBucketLabel(
  start: number,
  granularity: TrafficGranularity,
  kind: "axis" | "full",
  locale?: string,
): string {
  const date = new Date(start);
  if (granularity === "day") {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(kind === "full" ? { year: "numeric" } : {}),
    }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(kind === "full" ? { month: "short", day: "numeric" } : {}),
  }).format(date);
}
