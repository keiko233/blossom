import { describe, expect, it } from "vitest";

import {
  amountToCents,
  bytesToGb,
  centsToAmount,
  formatAmount,
  formatBytes,
  formatTraffic,
  gbToBytes,
  parseDuration,
  toDatetimeLocalValue,
} from "./format";

describe("formatBytes", () => {
  it("formats zero as 0 KB", () => {
    expect(formatBytes(0)).toBe("0 KB");
  });

  it("formats small values as KB with one decimal", () => {
    expect(formatBytes(500)).toBe("0.5 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes without locale separator", () => {
    expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
  });

  it("formats large megabytes with thousands separator", () => {
    expect(formatBytes(1023.5 * 1024 ** 2)).toBe("1,023.5 MB");
  });

  it("formats gigabytes with one decimal", () => {
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(formatBytes(100 * 1024 ** 3)).toBe("100 GB");
  });

  it("formats terabytes with two decimals", () => {
    expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5 TB");
  });
});

describe("formatTraffic", () => {
  it("formats zero as 0 GB", () => {
    expect(formatTraffic(0)).toBe("0 GB");
  });

  it("formats sub-gigabyte values as GB with two decimals", () => {
    expect(formatTraffic(0.49 * 1024 ** 3)).toBe("0.49 GB");
  });

  it("formats gigabytes without decimals", () => {
    expect(formatTraffic(100 * 1024 ** 3)).toBe("100 GB");
  });

  it("formats terabytes with two decimals", () => {
    expect(formatTraffic(1024 ** 4)).toBe("1 TB");
  });
});

describe("gbToBytes / bytesToGb", () => {
  it("converts GB to bytes and back", () => {
    expect(gbToBytes(100)).toBe(100 * 1024 ** 3);
    expect(bytesToGb(gbToBytes(100))).toBe(100);
  });

  it("returns integers for fractional GB", () => {
    expect(gbToBytes(1.5)).toBe(1610612736);
    expect(Number.isInteger(gbToBytes(1.5))).toBe(true);
  });
});

describe("parseDuration", () => {
  it("parses millisecond durations", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  it("parses second durations", () => {
    expect(parseDuration("5s")).toBe(5000);
  });

  it("parses minute durations", () => {
    expect(parseDuration("3m")).toBe(180000);
  });

  it("parses hour durations", () => {
    expect(parseDuration("2h")).toBe(7200000);
    expect(parseDuration("1.5h")).toBe(5400000);
  });

  it("returns undefined for invalid or unsupported values", () => {
    expect(parseDuration("abc")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(42)).toBeUndefined();
    expect(parseDuration("-5s")).toBeUndefined();
  });
});

describe("toDatetimeLocalValue", () => {
  it("formats a local date for datetime-local inputs", () => {
    expect(toDatetimeLocalValue(new Date(2026, 6, 10, 9, 5))).toBe(
      "2026-07-10T09:05",
    );
  });
});

describe("centsToAmount / amountToCents / formatAmount", () => {
  it("converts between cents and amount", () => {
    expect(centsToAmount(999)).toBe(9.99);
    expect(amountToCents(9.99)).toBe(999);
  });

  it("handles floating point rounding", () => {
    expect(amountToCents(0.1 + 0.2)).toBe(30);
  });

  it("formats amounts with two decimals", () => {
    expect(formatAmount(999)).toBe("9.99");
    expect(formatAmount(1000)).toBe("10.00");
  });
});
