import { describe, expect, it } from "vitest";

import {
  LOG_POLICY_CAPABILITY,
  LOG_POLICY_DEFAULT_TEMPORARY_SECONDS,
  LOG_POLICY_MAX_TEMPORARY_SECONDS,
  logPolicyAckPayloadSchema,
  logPolicyDesiredSourceSchema,
  logPolicySnapshotPayloadSchema,
} from "./log-policy";

const DEADLINE = "2026-11-19T00:15:00.000Z";

describe("log policy contract", () => {
  it("names the capability the control plane advertises", () => {
    expect(LOG_POLICY_CAPABILITY).toBe("log-policy-v1");
    expect(LOG_POLICY_DEFAULT_TEMPORARY_SECONDS).toBe(900);
    expect(LOG_POLICY_MAX_TEMPORARY_SECONDS).toBe(3_600);
  });

  it("requires a deadline for temporary levels and none for baselines", () => {
    expect(
      logPolicyDesiredSourceSchema.safeParse({
        source: "sing-box",
        revision: 4,
        level: "debug",
        deadline: DEADLINE,
      }).success,
    ).toBe(true);
    expect(
      logPolicyDesiredSourceSchema.safeParse({
        source: "sing-box",
        revision: 4,
        level: "debug",
        deadline: null,
      }).success,
    ).toBe(false);
    expect(
      logPolicyDesiredSourceSchema.safeParse({
        source: "agent",
        revision: 5,
        level: "warn",
        deadline: DEADLINE,
      }).success,
    ).toBe(false);
    expect(
      logPolicyDesiredSourceSchema.safeParse({
        source: "agent",
        revision: 5,
        level: "debug",
        deadline: "2026-11-19T00:15:00.000+00:00",
      }).success,
    ).toBe(true);
  });

  it("rejects a snapshot that names one source twice", () => {
    expect(
      logPolicySnapshotPayloadSchema.safeParse({
        requestId: "log-get-1",
        revision: 5,
        sources: [
          { source: "agent", revision: 4, level: "info", deadline: null },
          { source: "agent", revision: 5, level: "warn", deadline: null },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps apply status separate from the requested override", () => {
    const failed = {
      source: "sing-box",
      sourceRevision: 3,
      requested: "trace",
      baseline: "info",
      effective: "info",
      deadline: DEADLINE,
      error: "sing-box check rejected the candidate",
      pending: true,
    };
    expect(logPolicyAckPayloadSchema.safeParse(failed).success).toBe(true);
    expect(
      logPolicyAckPayloadSchema.safeParse({
        ...failed,
        error: "x".repeat(513),
      }).success,
    ).toBe(false);
  });
});
