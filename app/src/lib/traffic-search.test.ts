import { describe, expect, it } from "vitest";

import { MS_PER_DAY } from "./traffic-analytics";
import {
  searchToTrafficFilter,
  searchToTrafficRange,
  trafficSearchSchema,
} from "./traffic-search";

const NOW = Date.UTC(2026, 9, 29, 14);

describe("trafficSearchSchema", () => {
  it("accepts an empty search", () => {
    expect(trafficSearchSchema.parse({})).toEqual({});
  });

  it("drops garbage instead of throwing", () => {
    const parsed = trafficSearchSchema.parse({
      range: "1y",
      from: "2026-02-31",
      to: "yesterday",
      by: "galaxy",
      page: 0,
      pageSize: 7,
      sort: "magic",
      dir: "sideways",
    });
    expect(parsed).toEqual({});
  });

  it("keeps valid values and stringifies numeric-looking ids", () => {
    const parsed = trafficSearchSchema.parse({
      range: "7d",
      from: "2026-10-01",
      server: 123,
      by: "plan",
      page: 2,
      pageSize: 25,
      sort: "uplink",
      dir: "asc",
    });
    expect(parsed).toEqual({
      range: "7d",
      from: "2026-10-01",
      server: "123",
      by: "plan",
      page: 2,
      pageSize: 25,
      sort: "uplink",
      dir: "asc",
    });
  });
});

describe("searchToTrafficRange", () => {
  it("defaults to the 30d preset", () => {
    const range = searchToTrafficRange({}, NOW);
    expect(range.to - range.from).toBe(30 * MS_PER_DAY);
  });

  it("uses a preset", () => {
    const range = searchToTrafficRange({ range: "24h" }, NOW);
    expect(range.to - range.from).toBe(24 * 60 * 60 * 1000);
  });

  it("prefers custom days over the preset", () => {
    expect(
      searchToTrafficRange(
        { range: "7d", from: "2026-10-01", to: "2026-10-02" },
        NOW,
      ),
    ).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 3) });
  });
});

describe("searchToTrafficFilter", () => {
  it("serialises the range and trims entity ids", () => {
    const range = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 2) };
    expect(searchToTrafficFilter({ server: " s1 ", user: " " }, range)).toEqual(
      {
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
        serverId: "s1",
        nodeId: undefined,
        planId: undefined,
        userId: undefined,
      },
    );
  });
});
