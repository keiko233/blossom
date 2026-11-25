import { describe, expect, it } from "vitest";

import {
  capabilityOf,
  formatUsage,
  liveStateOf,
  streamTone,
  usagePercent,
} from "./server-live-state";

const base = {
  enabled: true,
  transportMode: "ws",
  wsConnectedAt: new Date("2026-11-26T12:00:00Z"),
  agentCapabilities: ["telemetry-v2"],
};

describe("capabilityOf", () => {
  it("prefers telemetry v2 over v1", () => {
    expect(
      capabilityOf({
        agentCapabilities: ["telemetry-v1", "telemetry-v2"],
      }),
    ).toBe("v2");
    expect(capabilityOf({ agentCapabilities: ["telemetry-v1"] })).toBe("v1");
    expect(capabilityOf({ agentCapabilities: ["pty-v1"] })).toBeNull();
  });
});

describe("liveStateOf", () => {
  it("reports a disabled server before transport state", () => {
    expect(liveStateOf({ ...base, enabled: false })).toBe("disabled");
  });

  it("reports HTTP fallback when the WebSocket is not connected", () => {
    expect(liveStateOf({ ...base, transportMode: "http" })).toBe("fallback");
    expect(liveStateOf({ ...base, wsConnectedAt: null })).toBe("fallback");
  });

  it("reports a connected agent without telemetry as legacy", () => {
    expect(liveStateOf({ ...base, agentCapabilities: [] })).toBe("legacy");
    expect(liveStateOf({ ...base, agentCapabilities: ["telemetry-v1"] })).toBe(
      "connected",
    );
    expect(liveStateOf(base)).toBe("connected");
  });
});

describe("usagePercent", () => {
  it("returns null for missing and zero totals", () => {
    expect(usagePercent(null, 100)).toBeNull();
    expect(usagePercent(10, null)).toBeNull();
    expect(usagePercent(10, 0)).toBeNull();
  });

  it("returns a percentage for a valid pair and null over 100", () => {
    expect(usagePercent(25, 100)).toBe(25);
    expect(usagePercent(101, 100)).toBeNull();
  });
});

describe("formatUsage", () => {
  it("formats the GiB pair through the caller's message", () => {
    expect(
      formatUsage(
        2 * 1024 ** 3,
        8 * 1024 ** 3,
        (used, total) => `${used}/${total}`,
        "missing",
      ),
    ).toBe("2.0/8.0");
  });

  it("returns the missing label when a value is absent", () => {
    expect(
      formatUsage(null, 8, (used, total) => `${used}/${total}`, "missing"),
    ).toBe("missing");
  });
});

describe("streamTone", () => {
  it("maps every phase to a status tone", () => {
    expect(streamTone("connected")).toBe("success");
    expect(streamTone("connecting")).toBe("info");
    expect(streamTone("reconnecting")).toBe("warning");
    expect(streamTone("paused")).toBe("muted");
    expect(streamTone("idle")).toBe("muted");
    expect(streamTone("error")).toBe("danger");
  });
});
