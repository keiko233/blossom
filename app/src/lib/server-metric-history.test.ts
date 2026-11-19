import { describe, expect, it } from "vitest";

import {
  fillMetricGrid,
  type MetricHistoryRow,
  metricMinuteStart,
  metricScopeKey,
  metricScopeOf,
  normalizeMetricSample,
  planMetricHistory,
  type ServerMetricSample,
  SERVER_METRIC_MAX_POINTS,
  SERVER_METRIC_RANGES,
  SERVER_METRIC_RETENTION_DAYS,
  splitMetricSegments,
} from "./server-metric-history";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 2026-11-19T12:34:56.789Z, deliberately off the minute and bucket grids.
const NOW = Date.UTC(2026, 10, 19, 12, 34, 56, 789);

function sample(
  overrides: Partial<ServerMetricSample> = {},
): ServerMetricSample {
  return {
    cpuPercent: 12.5,
    memory: { used: 512, total: 1024 },
    disk: { used: 100, total: 1000 },
    environment: "systemd",
    cgroupVersion: null,
    cpuLimit: null,
    memoryLimit: null,
    network: null,
    ...overrides,
  };
}

function row(
  startMs: number,
  overrides: Partial<MetricHistoryRow> = {},
): MetricHistoryRow {
  return {
    startMs,
    samples: 1,
    scope: "host",
    scopeKey: "systemd",
    cpuPercent: 10,
    memoryPercent: 50,
    diskPercent: 10,
    networkTxBytesPerSecond: null,
    networkRxBytesPerSecond: null,
    ...overrides,
  };
}

describe("planMetricHistory", () => {
  it("keeps every range within the point cap for any clock offset", () => {
    for (const range of SERVER_METRIC_RANGES) {
      for (let offset = 0; offset < 2 * HOUR; offset += 7 * MINUTE + 3_000) {
        const plan = planMetricHistory(range, NOW + offset);
        expect(plan.points).toBeLessThanOrEqual(SERVER_METRIC_MAX_POINTS);
        expect(plan.points).toBeGreaterThan(0);
        expect(plan.toMs - plan.fromMs).toBe(plan.points * plan.bucketMs);
      }
    }
  });

  it("uses one-minute buckets for the hour range and wider buckets beyond", () => {
    expect(planMetricHistory("1h", NOW)).toMatchObject({
      bucketMinutes: 1,
      points: 60,
    });
    expect(planMetricHistory("24h", NOW)).toMatchObject({
      bucketMinutes: 3,
      points: 480,
    });
    expect(planMetricHistory("30d", NOW)).toMatchObject({
      bucketMinutes: 72,
      points: 600,
    });
  });

  it("aligns buckets to the UTC epoch grid and includes the current bucket", () => {
    const plan = planMetricHistory("24h", NOW);
    expect(plan.fromMs % plan.bucketMs).toBe(0);
    expect(plan.toMs % plan.bucketMs).toBe(0);
    expect(plan.toMs).toBeGreaterThan(NOW);
    expect(plan.toMs - plan.bucketMs).toBeLessThanOrEqual(NOW);
  });

  it("keeps a stable grid for requests within the same bucket", () => {
    const first = planMetricHistory("24h", NOW);
    const later = planMetricHistory("24h", NOW + 60_000);
    expect(later.fromMs).toBe(first.fromMs);
    expect(later.toMs).toBe(first.toMs);
  });

  it("spans at most the retention window for the widest range", () => {
    const plan = planMetricHistory("30d", NOW);
    expect(plan.toMs - plan.fromMs).toBeLessThanOrEqual(
      SERVER_METRIC_RETENTION_DAYS * DAY,
    );
  });
});

describe("metricMinuteStart", () => {
  it("floors receipt times to the UTC minute", () => {
    expect(metricMinuteStart(NOW)).toBe(Date.UTC(2026, 10, 19, 12, 34));
  });
});

describe("normalizeMetricSample", () => {
  it("maps a complete systemd sample to host scope", () => {
    expect(normalizeMetricSample(sample())).toEqual({
      scope: "host",
      scopeKey: "systemd|-|-|-",
      cpuPercent: 12.5,
      memoryUsedBytes: 512,
      memoryTotalBytes: 1024,
      diskUsedBytes: 100,
      diskTotalBytes: 1000,
      networkTxBytesPerSecond: null,
      networkRxBytesPerSecond: null,
    });
  });

  it("turns invalid parts into gaps instead of zeros", () => {
    expect(
      normalizeMetricSample(
        sample({
          cpuPercent: Number.NaN,
          memory: { used: 2048, total: 1024 },
          disk: { used: 1, total: 0 },
        }),
      ),
    ).toBeNull();

    expect(
      normalizeMetricSample(
        sample({ cpuPercent: 150, memory: { used: 1, total: 2 } }),
      ),
    ).toMatchObject({
      cpuPercent: null,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
    });
  });

  it("drops a sample with nothing measured", () => {
    expect(
      normalizeMetricSample(
        sample({ cpuPercent: null, memory: null, disk: null }),
      ),
    ).toBeNull();
  });

  it("stores network rates only when both directions are valid", () => {
    expect(
      normalizeMetricSample(
        sample({
          network: { txBytesPerSecond: 10, rxBytesPerSecond: -1 },
        }),
      ),
    ).toMatchObject({
      networkTxBytesPerSecond: null,
      networkRxBytesPerSecond: null,
    });
    expect(
      normalizeMetricSample(
        sample({
          network: { txBytesPerSecond: 10, rxBytesPerSecond: 20 },
        }),
      ),
    ).toMatchObject({
      networkTxBytesPerSecond: 10,
      networkRxBytesPerSecond: 20,
    });
  });
});

describe("scope identity", () => {
  it("labels containers and keeps host environments as host", () => {
    expect(metricScopeOf("docker")).toBe("container");
    expect(metricScopeOf("kubernetes")).toBe("container");
    expect(metricScopeOf("systemd")).toBe("host");
    expect(metricScopeOf("unknown")).toBe("host");
  });

  it("changes the key when limits or the cgroup version change", () => {
    const base = sample({ environment: "docker", cgroupVersion: 2 });
    const limited = sample({
      environment: "docker",
      cgroupVersion: 2,
      cpuLimit: 2,
      memoryLimit: 2 ** 31,
    });
    expect(metricScopeKey(base)).not.toBe(metricScopeKey(limited));
    expect(metricScopeKey(base)).toBe(
      metricScopeKey(sample({ environment: "docker", cgroupVersion: 2 })),
    );
  });
});

describe("fillMetricGrid", () => {
  it("returns every grid bucket and marks absent ones as gaps", () => {
    const plan = planMetricHistory("1h", NOW);
    const present = row(plan.fromMs + 5 * plan.bucketMs);
    const grid = fillMetricGrid(plan, [present]);

    expect(grid).toHaveLength(plan.points);
    expect(grid[5]).toBe(present);
    expect(grid[4]).toMatchObject({ samples: 0, cpuPercent: null });
    expect(grid[4]!.startMs).toBe(plan.fromMs + 4 * plan.bucketMs);
  });

  it("ignores rows outside the plan grid", () => {
    const plan = planMetricHistory("1h", NOW);
    const grid = fillMetricGrid(plan, [row(plan.fromMs - plan.bucketMs)]);
    expect(grid.every((point) => point.samples === 0)).toBe(true);
  });
});

describe("splitMetricSegments", () => {
  const cpu = (point: MetricHistoryRow) => point.cpuPercent;
  const base = planMetricHistory("1h", NOW).fromMs;

  it("breaks the series at a missing interval", () => {
    const points = fillMetricGrid(planMetricHistory("1h", NOW), [
      row(base),
      row(base + MINUTE),
      row(base + 3 * MINUTE),
    ]);
    const segments = splitMetricSegments(points, cpu);
    expect(segments.map((s) => s.points.map((p) => p.index))).toEqual([
      [0, 1],
      [3],
    ]);
  });

  it("breaks the series when the measurement scope changes", () => {
    const points = [
      row(base, { scopeKey: "systemd" }),
      row(base + MINUTE, { scopeKey: "systemd" }),
      row(base + 2 * MINUTE, { scopeKey: "docker|cg2" }),
      row(base + 3 * MINUTE, { scopeKey: "docker|cg2" }),
    ];
    const segments = splitMetricSegments(points, cpu);
    expect(segments.map((s) => s.scopeKey)).toEqual(["systemd", "docker|cg2"]);
    expect(segments.map((s) => s.points.length)).toEqual([2, 2]);
  });

  it("breaks at a bucket whose value is null even with samples", () => {
    const points = [
      row(base),
      row(base + MINUTE, { cpuPercent: null, memoryPercent: 40 }),
      row(base + 2 * MINUTE),
    ];
    expect(
      splitMetricSegments(points, cpu).map((s) => s.points.length),
    ).toEqual([1, 1]);
    expect(
      splitMetricSegments(points, (p) => p.memoryPercent).map(
        (s) => s.points.length,
      ),
    ).toEqual([3]);
  });

  it("keeps an isolated sample as a single-point run", () => {
    const points = [row(base, { scopeKey: "a" })];
    const segments = splitMetricSegments(points, cpu);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.points).toEqual([
      { index: 0, startMs: base, value: 10 },
    ]);
  });
});
