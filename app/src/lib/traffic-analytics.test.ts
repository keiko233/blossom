import { describe, expect, it } from "vitest";

import {
  bucketStarts,
  changePercent,
  daysToRange,
  floorToBucket,
  formatBucketLabel,
  getTrafficGranularity,
  MS_PER_DAY,
  MS_PER_HOUR,
  parseUtcDay,
  presetToRange,
  previousRange,
  sharePercent,
  toUtcDay,
  zeroFillBuckets,
} from "./traffic-analytics";

const NOW = Date.UTC(2026, 9, 29, 14, 35, 12);

describe("presetToRange", () => {
  it("24h is 24 hourly buckets ending with the current hour", () => {
    const range = presetToRange("24h", NOW);
    expect(range.to).toBe(Date.UTC(2026, 9, 29, 15));
    expect(range.to - range.from).toBe(24 * MS_PER_HOUR);
    expect(getTrafficGranularity(range)).toBe("hour");
  });

  it("day presets end after today and are whole UTC days", () => {
    const range = presetToRange("7d", NOW);
    expect(range.to).toBe(Date.UTC(2026, 9, 30));
    expect(range.from).toBe(Date.UTC(2026, 9, 23));
    expect(getTrafficGranularity(range)).toBe("day");
    expect(bucketStarts(range, "day")).toHaveLength(7);
    expect(bucketStarts(presetToRange("90d", NOW), "day")).toHaveLength(90);
  });
});

describe("getTrafficGranularity", () => {
  it("switches from hour to day just above 48 hours", () => {
    expect(getTrafficGranularity({ from: 0, to: 48 * MS_PER_HOUR })).toBe(
      "hour",
    );
    expect(getTrafficGranularity({ from: 0, to: 48 * MS_PER_HOUR + 1 })).toBe(
      "day",
    );
  });
});

describe("parseUtcDay / toUtcDay", () => {
  it("parses real days and rejects overflow and garbage", () => {
    expect(parseUtcDay("2026-02-28")).toBe(Date.UTC(2026, 1, 28));
    expect(parseUtcDay("2026-02-31")).toBeUndefined();
    expect(parseUtcDay("nope")).toBeUndefined();
    expect(parseUtcDay(undefined)).toBeUndefined();
  });

  it("round-trips", () => {
    expect(toUtcDay(parseUtcDay("2026-10-29") as number)).toBe("2026-10-29");
  });
});

describe("daysToRange", () => {
  it("is undefined without any day", () => {
    expect(daysToRange(undefined, undefined, NOW)).toBeUndefined();
  });

  it("includes both end days", () => {
    expect(daysToRange("2026-10-01", "2026-10-03", NOW)).toEqual({
      from: Date.UTC(2026, 9, 1),
      to: Date.UTC(2026, 9, 4),
    });
  });

  it("defaults a missing end to today and a missing start to 30 days", () => {
    expect(daysToRange("2026-10-20", undefined, NOW)?.to).toBe(
      Date.UTC(2026, 9, 30),
    );
    const range = daysToRange(undefined, "2026-10-30", NOW);
    expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(30 * MS_PER_DAY);
  });

  it("collapses an inverted range to its end day", () => {
    expect(daysToRange("2026-10-10", "2026-10-05", NOW)).toEqual({
      from: Date.UTC(2026, 9, 5),
      to: Date.UTC(2026, 9, 6),
    });
  });

  it("caps the span at 366 days, keeping the end", () => {
    const range = daysToRange("2020-01-01", "2026-10-01", NOW);
    expect(range?.to).toBe(Date.UTC(2026, 9, 2));
    expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(366 * MS_PER_DAY);
  });
});

describe("previousRange", () => {
  it("is the equal-length range right before", () => {
    expect(previousRange({ from: 100, to: 160 })).toEqual({
      from: 40,
      to: 100,
    });
  });
});

describe("bucketStarts / zeroFillBuckets", () => {
  it("floors an unaligned start to its bucket", () => {
    const from = Date.UTC(2026, 9, 29, 10, 30);
    const to = Date.UTC(2026, 9, 29, 13);
    expect(bucketStarts({ from, to }, "hour")).toEqual([
      Date.UTC(2026, 9, 29, 10),
      Date.UTC(2026, 9, 29, 11),
      Date.UTC(2026, 9, 29, 12),
    ]);
    expect(floorToBucket(from, "day")).toBe(Date.UTC(2026, 9, 29));
  });

  it("zero-fills missing buckets and keeps the known ones", () => {
    const range = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 4) };
    const filled = zeroFillBuckets(
      [{ start: Date.UTC(2026, 9, 2), uplink: 5, downlink: 7 }],
      range,
      "day",
    );
    expect(filled).toEqual([
      { start: Date.UTC(2026, 9, 1), uplink: 0, downlink: 0 },
      { start: Date.UTC(2026, 9, 2), uplink: 5, downlink: 7 },
      { start: Date.UTC(2026, 9, 3), uplink: 0, downlink: 0 },
    ]);
  });

  it("ignores rows outside the range", () => {
    const filled = zeroFillBuckets(
      [{ start: 0, uplink: 1, downlink: 1 }],
      { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 2) },
      "day",
    );
    expect(filled).toEqual([
      { start: Date.UTC(2026, 9, 1), uplink: 0, downlink: 0 },
    ]);
  });
});

describe("changePercent / sharePercent", () => {
  it("computes relative change", () => {
    expect(changePercent(150, 100)).toBe(50);
    expect(changePercent(50, 100)).toBe(-50);
    expect(changePercent(0, 100)).toBe(-100);
  });

  it("has no change without a baseline", () => {
    expect(changePercent(10, 0)).toBeNull();
    expect(changePercent(0, 0)).toBeNull();
  });

  it("computes shares and survives an empty whole", () => {
    expect(sharePercent(25, 100)).toBe(25);
    expect(sharePercent(5, 0)).toBe(0);
  });
});

describe("formatBucketLabel", () => {
  const start = Date.UTC(2026, 9, 29, 7);

  it("labels hours in UTC", () => {
    expect(formatBucketLabel(start, "hour", "axis", "en-US")).toBe("07:00");
    expect(formatBucketLabel(start, "hour", "full", "en-US")).toContain(
      "Oct 29",
    );
  });

  it("labels days in UTC regardless of the runtime zone", () => {
    const lateEvening = Date.UTC(2026, 9, 29, 23);
    expect(formatBucketLabel(lateEvening, "day", "axis", "en-US")).toBe(
      "Oct 29",
    );
    expect(formatBucketLabel(lateEvening, "day", "full", "en-US")).toBe(
      "Oct 29, 2026",
    );
  });
});
