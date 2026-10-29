import { describe, expect, it } from "vitest";

import {
  planTrialPeriod,
  shouldGrantTrial,
  trialSubscriptionId,
} from "./trial";

describe("trialSubscriptionId", () => {
  it("is deterministic per user, so a second grant collides on the key", () => {
    expect(trialSubscriptionId("u1")).toBe(trialSubscriptionId("u1"));
    expect(trialSubscriptionId("u1")).not.toBe(trialSubscriptionId("u2"));
  });
});

describe("shouldGrantTrial", () => {
  const on = { enabled: true, planId: "p1" };

  it("grants to self-service sign-ups", () => {
    for (const method of ["email-password", "magic-link", "oauth"]) {
      expect(shouldGrantTrial(on, method), method).toBe(true);
    }
  });

  it("never grants to admin-created accounts", () => {
    expect(shouldGrantTrial(on, "admin")).toBe(false);
  });

  it("needs trials enabled and a plan", () => {
    expect(shouldGrantTrial({ enabled: false, planId: "p1" }, "oauth")).toBe(
      false,
    );
    expect(shouldGrantTrial({ enabled: true, planId: null }, "oauth")).toBe(
      false,
    );
  });
});

describe("planTrialPeriod", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("uses the plan's duration by default", () => {
    const period = planTrialPeriod(
      { durationDays: null },
      { durationDays: 30 },
      now,
    );
    expect(period.durationDays).toBe(30);
    expect(period.startedAt).toEqual(now);
    expect(period.expiresAt.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("lets the override replace the plan's duration", () => {
    const period = planTrialPeriod(
      { durationDays: 3 },
      { durationDays: 30 },
      now,
    );
    expect(period.expiresAt.toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });
});
