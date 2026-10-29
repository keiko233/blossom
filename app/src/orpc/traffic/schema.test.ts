import { describe, expect, it } from "vitest";

import {
  exportTrafficCsvSchema,
  getTrafficBreakdownSchema,
  trafficFilterSchema,
} from "./schema";

const range = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-08T00:00:00.000Z",
};

describe("trafficFilterSchema", () => {
  it("accepts a range with optional entity filters", () => {
    expect(trafficFilterSchema.safeParse(range).success).toBe(true);
    expect(
      trafficFilterSchema.safeParse({ ...range, serverId: "s", userId: "u" })
        .success,
    ).toBe(true);
  });

  it("rejects empty and inverted ranges", () => {
    expect(
      trafficFilterSchema.safeParse({ from: range.to, to: range.to }).success,
    ).toBe(false);
    expect(
      trafficFilterSchema.safeParse({ from: range.to, to: range.from }).success,
    ).toBe(false);
  });

  it("caps the range at 366 days", () => {
    expect(
      trafficFilterSchema.safeParse({
        from: "2025-10-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      trafficFilterSchema.safeParse({
        from: "2025-10-01T00:00:00.000Z",
        to: "2026-10-03T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects non-ISO instants and blank ids", () => {
    expect(
      trafficFilterSchema.safeParse({ ...range, from: "yesterday" }).success,
    ).toBe(false);
    expect(
      trafficFilterSchema.safeParse({ ...range, nodeId: " " }).success,
    ).toBe(false);
  });
});

describe("getTrafficBreakdownSchema", () => {
  it("fills sort and pagination defaults", () => {
    expect(
      getTrafficBreakdownSchema.parse({ ...range, dimension: "user" }),
    ).toMatchObject({ sort: "total", sortDir: "desc", page: 1, pageSize: 10 });
  });

  it("rejects an unknown dimension and an oversized page", () => {
    expect(
      getTrafficBreakdownSchema.safeParse({ ...range, dimension: "x" }).success,
    ).toBe(false);
    expect(
      getTrafficBreakdownSchema.safeParse({
        ...range,
        dimension: "user",
        pageSize: 500,
      }).success,
    ).toBe(false);
  });
});

describe("exportTrafficCsvSchema", () => {
  it("takes the series or any dimension", () => {
    for (const kind of ["series", "user", "server", "node", "plan"]) {
      expect(exportTrafficCsvSchema.safeParse({ ...range, kind }).success).toBe(
        true,
      );
    }
    expect(
      exportTrafficCsvSchema.safeParse({ ...range, kind: "all" }).success,
    ).toBe(false);
  });
});
