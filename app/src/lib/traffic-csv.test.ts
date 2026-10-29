import { describe, expect, it } from "vitest";

import {
  trafficBreakdownCsvColumns,
  trafficBreakdownToCsv,
  trafficSeriesToCsv,
} from "./traffic-csv";

describe("trafficSeriesToCsv", () => {
  it("writes UTC ISO bucket starts and totals", () => {
    const csv = trafficSeriesToCsv([
      { start: Date.UTC(2026, 9, 1), uplink: 10, downlink: 30 },
      { start: Date.UTC(2026, 9, 2), uplink: 0, downlink: 0 },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "bucket_start_utc,uplink_bytes,downlink_bytes,total_bytes",
      "2026-10-01T00:00:00.000Z,10,30,40",
      "2026-10-02T00:00:00.000Z,0,0,0",
    ]);
  });

  it("is just the header for no buckets", () => {
    expect(trafficSeriesToCsv([])).toBe(
      "bucket_start_utc,uplink_bytes,downlink_bytes,total_bytes",
    );
  });
});

describe("trafficBreakdownToCsv", () => {
  it("adds an email column for users only", () => {
    expect(trafficBreakdownCsvColumns("user")).toContain("email");
    expect(trafficBreakdownCsvColumns("server")).toEqual([
      "server_id",
      "name",
      "uplink_bytes",
      "downlink_bytes",
      "total_bytes",
      "share_percent",
    ]);
  });

  it("writes shares and defuses spreadsheet formulas", () => {
    const csv = trafficBreakdownToCsv(
      "user",
      [
        {
          id: "u1",
          name: "=cmd",
          email: "a@x.io",
          uplink: 1,
          downlink: 2,
          total: 3,
        },
      ],
      12,
    );
    expect(csv.split("\r\n")[1]).toBe("u1,'=cmd,a@x.io,1,2,3,25");
  });

  it("leaves deleted entities blank and survives a zero total", () => {
    const csv = trafficBreakdownToCsv(
      "server",
      [{ id: null, name: null, email: null, uplink: 0, downlink: 0, total: 0 }],
      0,
    );
    expect(csv.split("\r\n")[1]).toBe(",,0,0,0,0");
  });
});
