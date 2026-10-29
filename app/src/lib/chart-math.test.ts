import { describe, expect, it } from "vitest";

import {
  bandIndexAt,
  clamp,
  labelIndices,
  niceByteTicks,
  scaleLinear,
  stackSeries,
} from "./chart-math";

const GB = 1024 ** 3;

describe("scaleLinear", () => {
  it("maps linearly and can invert (SVG y)", () => {
    const y = scaleLinear([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
    expect(y(100)).toBe(0);
  });

  it("maps a zero-width domain to the range start", () => {
    expect(scaleLinear([5, 5], [10, 20])(5)).toBe(10);
  });
});

describe("clamp", () => {
  it("limits to the bounds", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe("stackSeries", () => {
  it("stacks later series on earlier ones", () => {
    expect(
      stackSeries([
        [1, 0, 3],
        [2, 4, 0],
      ]),
    ).toEqual([
      [
        { y0: 0, y1: 1 },
        { y0: 0, y1: 0 },
        { y0: 0, y1: 3 },
      ],
      [
        { y0: 1, y1: 3 },
        { y0: 0, y1: 4 },
        { y0: 3, y1: 3 },
      ],
    ]);
  });

  it("treats negative, NaN and missing values as zero", () => {
    const [first, second] = stackSeries([[-5, Number.NaN], [2]]);
    expect(first).toEqual([
      { y0: 0, y1: 0 },
      { y0: 0, y1: 0 },
    ]);
    expect(second).toEqual([
      { y0: 0, y1: 2 },
      { y0: 0, y1: 0 },
    ]);
  });

  it("is empty for no series", () => {
    expect(stackSeries([])).toEqual([]);
  });
});

describe("niceByteTicks", () => {
  it("falls back to a 0..1 KB axis without data", () => {
    expect(niceByteTicks(0)).toEqual({ ticks: [0, 1024], max: 1024 });
    expect(niceByteTicks(Number.NaN).max).toBe(1024);
  });

  it("uses whole units of the fitting size", () => {
    const { ticks, max } = niceByteTicks(3.4 * GB);
    expect(ticks).toEqual([0, GB, 2 * GB, 3 * GB, 4 * GB]);
    expect(max).toBe(4 * GB);
  });

  it("always covers the data and starts at zero", () => {
    for (const value of [1, 700, 1500, 9e5, 5.5e7, 2.2e10, 7.7e12]) {
      const { ticks, max } = niceByteTicks(value);
      expect(ticks[0]).toBe(0);
      expect(max).toBeGreaterThanOrEqual(value);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(8);
      // strictly increasing
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1] as number);
      }
    }
  });

  it("steps by 1, 2 or 5 in the unit", () => {
    expect(niceByteTicks(9 * GB).ticks.map((t) => t / GB)).toEqual([
      0, 2, 4, 6, 8, 10,
    ]);
    expect(niceByteTicks(1.6 * 1024 ** 2).ticks[1]).toBe(512 * 1024);
  });
});

describe("bandIndexAt", () => {
  it("finds the band and clamps the right edge", () => {
    expect(bandIndexAt(10, 10, 100, 4)).toBe(0);
    expect(bandIndexAt(40, 10, 100, 4)).toBe(1);
    expect(bandIndexAt(110, 10, 100, 4)).toBe(3);
  });

  it("is null outside the plot or without bands", () => {
    expect(bandIndexAt(5, 10, 100, 4)).toBeNull();
    expect(bandIndexAt(111, 10, 100, 4)).toBeNull();
    expect(bandIndexAt(50, 10, 100, 0)).toBeNull();
  });
});

describe("labelIndices", () => {
  it("labels every band when there is room", () => {
    expect(labelIndices(3, 100, 60)).toEqual([0, 1, 2]);
  });

  it("thins labels on narrow bands", () => {
    expect(labelIndices(10, 20, 60)).toEqual([0, 3, 6, 9]);
    expect(labelIndices(0, 20, 60)).toEqual([]);
  });
});
