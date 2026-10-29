import { describe, expect, it } from "vitest";

import {
  authorizationPlanIds,
  extendExpiry,
  needsAuthorizationRecord,
  resolveBulkPatch,
} from "./subscription-bulk";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-13T00:00:00Z");
const future = new Date(now.getTime() + 10 * DAY);
const past = new Date(now.getTime() - 10 * DAY);

describe("extendExpiry", () => {
  it("extends from the current expiry when it is still ahead", () => {
    expect(extendExpiry(future, 30, "expiry", now).getTime()).toBe(
      future.getTime() + 30 * DAY,
    );
  });

  it("extends from now when the expiry already passed", () => {
    expect(extendExpiry(past, 30, "expiry", now).getTime()).toBe(
      now.getTime() + 30 * DAY,
    );
  });

  it("extends from now when asked, even if the expiry is ahead", () => {
    expect(extendExpiry(future, 30, "now", now).getTime()).toBe(
      now.getTime() + 30 * DAY,
    );
  });

  it("treats an expiry equal to now as expired", () => {
    expect(extendExpiry(now, 1, "expiry", now).getTime()).toBe(
      now.getTime() + DAY,
    );
  });
});

describe("resolveBulkPatch", () => {
  const existing = { expiresAt: future };
  const plan = { id: "plan-b", trafficBytes: 5000, deviceLimit: 2 };

  it("builds the extend patch", () => {
    expect(
      resolveBulkPatch(
        { type: "extend", days: 7, base: "expiry" },
        existing,
        undefined,
        now,
      ),
    ).toEqual({ expiresAt: new Date(future.getTime() + 7 * DAY) });
  });

  it("resets traffic", () => {
    expect(
      resolveBulkPatch({ type: "resetTraffic" }, existing, undefined, now),
    ).toEqual({ trafficUsedBytes: 0 });
  });

  it("sets status", () => {
    expect(
      resolveBulkPatch(
        { type: "setStatus", status: "cancelled" },
        existing,
        undefined,
        now,
      ),
    ).toEqual({ status: "cancelled" });
  });

  it("changes plan without touching the snapshot by default", () => {
    expect(
      resolveBulkPatch(
        { type: "changePlan", planId: "plan-b", resnapshot: false },
        existing,
        plan,
        now,
      ),
    ).toEqual({ planId: "plan-b" });
  });

  it("re-snapshots quota and device limit on request", () => {
    expect(
      resolveBulkPatch(
        { type: "changePlan", planId: "plan-b", resnapshot: true },
        existing,
        plan,
        now,
      ),
    ).toEqual({
      planId: "plan-b",
      trafficQuotaBytes: 5000,
      deviceLimit: 2,
    });
  });

  it("requires the target plan for a plan change", () => {
    expect(() =>
      resolveBulkPatch(
        { type: "changePlan", planId: "x", resnapshot: false },
        existing,
        undefined,
        now,
      ),
    ).toThrow("Plan not found");
  });
});

describe("needsAuthorizationRecord", () => {
  const before = { status: "active", expiresAt: future, planId: "a" } as const;

  it("is false when nothing gated changed", () => {
    expect(
      needsAuthorizationRecord(before, {
        ...before,
        expiresAt: new Date(future),
      }),
    ).toBe(false);
  });

  it("is true when status moves", () => {
    expect(
      needsAuthorizationRecord(before, { ...before, status: "cancelled" }),
    ).toBe(true);
  });

  it("is true when expiry moves", () => {
    expect(
      needsAuthorizationRecord(before, {
        ...before,
        expiresAt: new Date(future.getTime() + 1),
      }),
    ).toBe(true);
  });

  it("is true when the plan moves", () => {
    expect(needsAuthorizationRecord(before, { ...before, planId: "b" })).toBe(
      true,
    );
  });
});

describe("authorizationPlanIds", () => {
  it("covers old and new plans", () => {
    expect(authorizationPlanIds({ planId: "a" }, { planId: "b" })).toEqual([
      "a",
      "b",
    ]);
  });

  it("dedupes an unchanged plan", () => {
    expect(authorizationPlanIds({ planId: "a" }, { planId: "a" })).toEqual([
      "a",
    ]);
  });
});
