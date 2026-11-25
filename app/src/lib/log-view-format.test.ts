import { describe, expect, it } from "vitest";

import {
  formatLogTime,
  logLevelVariant,
  logLevelVariants,
  logRowVariants,
  padLevel,
  resultsPlacement,
} from "./log-view-format";

describe("formatLogTime", () => {
  it("formats an ISO UTC timestamp as HH:MM:SS.mmm", () => {
    expect(formatLogTime("2026-11-19T12:04:05.123Z")).toBe("12:04:05.123");
  });

  it("pads and truncates fractional seconds", () => {
    expect(formatLogTime("2026-11-19T12:04:05Z")).toBe("12:04:05.000");
    expect(formatLogTime("2026-11-19T12:04:05.5Z")).toBe("12:04:05.500");
    expect(formatLogTime("2026-11-19T12:04:05.123456Z")).toBe("12:04:05.123");
  });

  it("normalizes an explicit UTC offset", () => {
    expect(formatLogTime("2026-11-19T20:04:05.000+08:00")).toBe("12:04:05.000");
  });

  it("returns a placeholder for short and malformed input without throwing", () => {
    expect(formatLogTime("2026-11-19T12:04")).toBe("--:--:--.---");
    expect(formatLogTime("12:04:05.123")).toBe("--:--:--.---");
    expect(formatLogTime("")).toBe("--:--:--.---");
    expect(formatLogTime("not-a-time")).toBe("--:--:--.---");
  });
});

describe("padLevel", () => {
  it("pads every known level to five uppercase characters", () => {
    expect(padLevel("trace")).toBe("TRACE");
    expect(padLevel("debug")).toBe("DEBUG");
    expect(padLevel("info")).toBe("INFO ");
    expect(padLevel("warn")).toBe("WARN ");
    expect(padLevel("error")).toBe("ERROR");
  });

  it("normalizes unknown input instead of failing", () => {
    expect(padLevel(" Verbose ")).toBe("VERBO");
    expect(padLevel("")).toBe("     ");
  });
});

describe("logLevelVariants", () => {
  it("uses the documented token class per level", () => {
    expect(logLevelVariants({ level: "trace" })).toContain(
      "text-muted-foreground",
    );
    expect(logLevelVariants({ level: "debug" })).toContain(
      "text-muted-foreground",
    );
    expect(logLevelVariants({ level: "info" })).toContain(
      "text-info-foreground",
    );
    expect(logLevelVariants({ level: "warn" })).toContain(
      "text-warning-foreground",
    );
    expect(logLevelVariants({ level: "error" })).toContain(
      "text-destructive-foreground",
    );
    expect(logLevelVariants({ level: "unknown" })).toContain(
      "text-muted-foreground",
    );
  });

  it("narrows known levels and falls back for unknown input", () => {
    expect(logLevelVariant("warn")).toBe("warn");
    expect(logLevelVariant("ERROR")).toBe("unknown");
    expect(logLevelVariant("verbose")).toBe("unknown");
  });
});

describe("logRowVariants", () => {
  it("keeps the fixed column template and gap tone", () => {
    expect(logRowVariants({ state: "idle" })).toContain(
      "grid-cols-[1.25rem_8.5rem_3.75rem_5.5rem_minmax(0,1fr)_auto]",
    );
    expect(logRowVariants({ state: "gap" })).toContain("bg-warning/8");
    expect(logRowVariants({ state: "active" })).toContain("bg-accent/60");
  });
});

describe("resultsPlacement", () => {
  it("docks results right at and above the breakpoint", () => {
    expect(resultsPlacement(1279)).toBe("bottom");
    expect(resultsPlacement(1280)).toBe("right");
    expect(resultsPlacement(2560)).toBe("right");
  });
});
