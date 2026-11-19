/**
 * Pure rules for the PostgreSQL-backed host metric history: range planning
 * and downsampling, minute bucketing, sample normalization, scope identity,
 * and gap-aware series splitting. No database or clock access; the query
 * module supplies rows and `nowMs`.
 */

export const SERVER_METRIC_RETENTION_DAYS = 30;
/** Hard cap on points returned for one range, so the chart stays bounded. */
export const SERVER_METRIC_MAX_POINTS = 600;

export const SERVER_METRIC_RANGES = ["1h", "24h", "7d", "30d"] as const;
export type ServerMetricRange = (typeof SERVER_METRIC_RANGES)[number];

const MS_PER_MINUTE = 60_000;

const RANGE_MINUTES: Record<ServerMetricRange, number> = {
  "1h": 60,
  "24h": 24 * 60,
  "7d": 7 * 24 * 60,
  "30d": 30 * 24 * 60,
};

export interface MetricHistoryPlan {
  range: ServerMetricRange;
  /** Inclusive start of the first bucket, epoch ms, aligned to `bucketMs`. */
  fromMs: number;
  /** Exclusive end of the last bucket, which includes the current bucket. */
  toMs: number;
  bucketMinutes: number;
  bucketMs: number;
  /** Number of buckets in `[fromMs, toMs)`; never above the point cap. */
  points: number;
}

/**
 * Chooses the bucket width so the whole range fits in at most
 * `SERVER_METRIC_MAX_POINTS` buckets. Buckets are aligned to multiples of
 * their width in UTC epoch time, so the same grid is produced for every
 * request made within one bucket.
 */
export function planMetricHistory(
  range: ServerMetricRange,
  nowMs: number,
): MetricHistoryPlan {
  const rangeMinutes = RANGE_MINUTES[range];
  const bucketMinutes = Math.max(
    1,
    Math.ceil(rangeMinutes / SERVER_METRIC_MAX_POINTS),
  );
  const bucketMs = bucketMinutes * MS_PER_MINUTE;
  const toMs = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
  const points = Math.ceil((rangeMinutes * MS_PER_MINUTE) / bucketMs);
  return {
    range,
    fromMs: toMs - points * bucketMs,
    toMs,
    bucketMinutes,
    bucketMs,
    points,
  };
}

/** Start of the UTC minute containing `ms`; the history row key. */
export function metricMinuteStart(ms: number): number {
  return Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/** Start of the bucket containing `ms` on a plan's grid. */
export function metricBucketStart(plan: MetricHistoryPlan, ms: number): number {
  return Math.floor(ms / plan.bucketMs) * plan.bucketMs;
}

/**
 * A host sample as the agent reports it, after the caller has mapped the
 * telemetry frame. Network rates are null until the agent reports them.
 */
export interface ServerMetricSample {
  cpuPercent: number | null;
  memory: MetricUsage | null;
  disk: MetricUsage | null;
  environment: string;
  cgroupVersion: 1 | 2 | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  network: { txBytesPerSecond: number; rxBytesPerSecond: number } | null;
}

export interface MetricUsage {
  used: number;
  total: number;
}

export type ServerMetricScopeLabel = "host" | "container";

/** A sample whose invalid parts are dropped; at least one part remains. */
export interface StorableMetricSample {
  scope: ServerMetricScopeLabel;
  scopeKey: string;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  networkTxBytesPerSecond: number | null;
  networkRxBytesPerSecond: number | null;
}

const CONTAINER_ENVIRONMENTS = new Set([
  "docker",
  "containerd",
  "kubernetes",
  "container",
]);

/** Container environments measure a cgroup view; everything else is host. */
export function metricScopeOf(environment: string): ServerMetricScopeLabel {
  return CONTAINER_ENVIRONMENTS.has(environment) ? "container" : "host";
}

/**
 * Canonical scope identity. Two samples are comparable only when their keys
 * are equal, so a change of environment, cgroup version or limits starts a
 * new series.
 */
export function metricScopeKey(
  sample: Pick<
    ServerMetricSample,
    "environment" | "cgroupVersion" | "cpuLimit" | "memoryLimit"
  >,
): string {
  return [
    sample.environment,
    sample.cgroupVersion === null ? "-" : `cg${sample.cgroupVersion}`,
    sample.cpuLimit === null ? "-" : `cpu${sample.cpuLimit}`,
    sample.memoryLimit === null ? "-" : `mem${sample.memoryLimit}`,
  ].join("|");
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validUsage(usage: MetricUsage | null): MetricUsage | null {
  if (!usage) return null;
  const used = finiteNonNegative(usage.used);
  const total = finiteNonNegative(usage.total);
  if (used === null || total === null || total <= 0 || used > total) {
    return null;
  }
  return { used, total };
}

/**
 * Drops invalid measurements so they become gaps rather than zeros, and
 * returns null when nothing usable is left. A malformed CPU value or an
 * impossible memory total never reaches the history table.
 */
export function normalizeMetricSample(
  sample: ServerMetricSample,
  scopeKey: string = metricScopeKey(sample),
): StorableMetricSample | null {
  const cpu =
    typeof sample.cpuPercent === "number" &&
    Number.isFinite(sample.cpuPercent) &&
    sample.cpuPercent >= 0 &&
    sample.cpuPercent <= 100
      ? sample.cpuPercent
      : null;
  const memory = validUsage(sample.memory);
  const disk = validUsage(sample.disk);
  const tx = finiteNonNegative(sample.network?.txBytesPerSecond);
  const rx = finiteNonNegative(sample.network?.rxBytesPerSecond);
  const hasNetwork = tx !== null && rx !== null;
  if (cpu === null && !memory && !disk && !hasNetwork) return null;
  return {
    scope: metricScopeOf(sample.environment),
    scopeKey,
    cpuPercent: cpu,
    memoryUsedBytes: memory?.used ?? null,
    memoryTotalBytes: memory?.total ?? null,
    diskUsedBytes: disk?.used ?? null,
    diskTotalBytes: disk?.total ?? null,
    networkTxBytesPerSecond: hasNetwork ? tx : null,
    networkRxBytesPerSecond: hasNetwork ? rx : null,
  };
}

/** One aggregated bucket returned by the query, before gap filling. */
export interface MetricHistoryRow {
  /** Bucket start, epoch ms. */
  startMs: number;
  samples: number;
  scope: ServerMetricScopeLabel;
  scopeKey: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  networkTxBytesPerSecond: number | null;
  networkRxBytesPerSecond: number | null;
}

/**
 * Places sparse query rows onto the plan's full bucket grid. A bucket without
 * samples is a gap point (`samples` 0, every value null), so the chart can
 * draw a break instead of interpolating across an outage.
 */
export function fillMetricGrid(
  plan: MetricHistoryPlan,
  rows: readonly MetricHistoryRow[],
): MetricHistoryRow[] {
  const byStart = new Map(rows.map((row) => [row.startMs, row]));
  return Array.from({ length: plan.points }, (_, index) => {
    const startMs = plan.fromMs + index * plan.bucketMs;
    const row = byStart.get(startMs);
    if (row) return row;
    return {
      startMs,
      samples: 0,
      scope: "host",
      scopeKey: "",
      cpuPercent: null,
      memoryPercent: null,
      diskPercent: null,
      networkTxBytesPerSecond: null,
      networkRxBytesPerSecond: null,
    };
  });
}

/** A run of consecutive points with a value, all in one scope. */
export interface MetricSegment {
  scopeKey: string;
  points: { index: number; startMs: number; value: number }[];
}

/**
 * Splits one metric into drawable runs. A run ends at a gap (null value or an
 * empty bucket) and at a change of scope, so percentages from different
 * denominators are never joined. A single-point run is kept so that an
 * isolated sample remains visible.
 */
export function splitMetricSegments(
  points: readonly MetricHistoryRow[],
  value: (point: MetricHistoryRow) => number | null,
): MetricSegment[] {
  const segments: MetricSegment[] = [];
  let open: MetricSegment | undefined;
  for (const [index, point] of points.entries()) {
    const y = value(point);
    if (y === null || point.samples === 0) {
      open = undefined;
      continue;
    }
    if (open?.scopeKey !== point.scopeKey) {
      open = { scopeKey: point.scopeKey, points: [] };
      segments.push(open);
    }
    open.points.push({ index, startMs: point.startMs, value: y });
  }
  return segments;
}
