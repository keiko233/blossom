import { describe, expect, it } from "vitest";

import {
  deriveNodeHealth,
  deriveServerHealth,
  type AgentStatusLike,
} from "./agent-status";

const now = Date.parse("2026-07-13T00:00:00Z");
const base: AgentStatusLike = {
  enabled: true,
  lastSeenAt: new Date(now - 10_000),
  heartbeatIntervalSeconds: 30,
  runtimeState: "running",
  configState: "applied",
  appliedRevision: "sha256:ok",
  activeNodeIds: ["active"],
};

describe("agent status", () => {
  it("derives a healthy server and materialized node", () => {
    expect(deriveServerHealth(base, now)).toBe("online");
    expect(deriveNodeHealth("active", true, base, now)).toBe("serving");
    expect(deriveNodeHealth("idle", true, base, now)).toBe("idle");
  });

  it("keeps an old active node serving when a candidate is rejected", () => {
    const rejected = { ...base, configState: "rejected" };
    expect(deriveServerHealth(rejected, now)).toBe("degraded");
    expect(deriveNodeHealth("active", true, rejected, now)).toBe(
      "serving_stale",
    );
    expect(deriveNodeHealth("new", true, rejected, now)).toBe("config_error");
  });

  it("uses the configured heartbeat interval for reachability", () => {
    const stale = { ...base, lastSeenAt: new Date(now - 91_000) };
    expect(deriveServerHealth(stale, now)).toBe("agent_offline");
  });
});
