import { describe, expect, it } from "vitest";

import {
  findExtendableSubscription,
  planRedeemGrant,
  topUpQuota,
} from "./redeem-grant";

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const now = new Date("2026-10-29T00:00:00Z");
const plan = { id: "p1", durationDays: 30, trafficBytes: 100 * GB };

function sub(
  overrides: Partial<
    Parameters<typeof findExtendableSubscription>[0][number]
  > = {},
) {
  return {
    id: "s1",
    planId: "p1",
    status: "active" as const,
    expiresAt: new Date(now.getTime() + 10 * DAY),
    trafficQuotaBytes: 100 * GB,
    ...overrides,
  };
}

describe("topUpQuota", () => {
  it("adds one plan allowance", () => {
    expect(topUpQuota(100 * GB, 50 * GB)).toBe(150 * GB);
  });

  it("keeps unlimited on either side", () => {
    expect(topUpQuota(0, 50 * GB)).toBe(0);
    expect(topUpQuota(100 * GB, 0)).toBe(0);
    expect(topUpQuota(0, 0)).toBe(0);
  });
});

describe("findExtendableSubscription", () => {
  it("only matches active, unexpired subscriptions on the same plan", () => {
    const subs = [
      sub({ id: "other-plan", planId: "p2" }),
      sub({ id: "cancelled", status: "cancelled" }),
      sub({ id: "expired-status", status: "expired" }),
      sub({ id: "past", expiresAt: new Date(now.getTime() - DAY) }),
    ];
    expect(findExtendableSubscription(subs, "p1", now)).toBeUndefined();
  });

  it("prefers the one expiring last", () => {
    const subs = [
      sub({ id: "a", expiresAt: new Date(now.getTime() + 5 * DAY) }),
      sub({ id: "b", expiresAt: new Date(now.getTime() + 50 * DAY) }),
    ];
    expect(findExtendableSubscription(subs, "p1", now)?.id).toBe("b");
  });
});

describe("planRedeemGrant", () => {
  it("new mode creates a subscription of the plan's duration", () => {
    const grant = planRedeemGrant({
      mode: "new",
      durationDays: null,
      plan,
      userSubscriptions: [sub()],
      now,
    });
    expect(grant).toEqual({
      kind: "create",
      startedAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY),
    });
  });

  it("honours the duration override", () => {
    const grant = planRedeemGrant({
      mode: "new",
      durationDays: 7,
      plan,
      userSubscriptions: [],
      now,
    });
    expect(grant).toMatchObject({
      kind: "create",
      expiresAt: new Date(now.getTime() + 7 * DAY),
    });
  });

  it("extend mode renews the active same-plan subscription", () => {
    const existing = sub();
    const grant = planRedeemGrant({
      mode: "extend",
      durationDays: null,
      plan,
      userSubscriptions: [existing],
      now,
    });
    expect(grant).toEqual({
      kind: "extend",
      subscriptionId: "s1",
      patch: {
        // From the current expiry, not from now.
        expiresAt: new Date(existing.expiresAt.getTime() + 30 * DAY),
        trafficQuotaBytes: 200 * GB,
      },
    });
  });

  it("extend mode creates when there is nothing to extend", () => {
    const grant = planRedeemGrant({
      mode: "extend",
      durationDays: 14,
      plan,
      userSubscriptions: [
        sub({ expiresAt: new Date(now.getTime() - DAY) }),
        sub({ id: "x", planId: "p2" }),
      ],
      now,
    });
    expect(grant).toEqual({
      kind: "create",
      startedAt: now,
      expiresAt: new Date(now.getTime() + 14 * DAY),
    });
  });
});
