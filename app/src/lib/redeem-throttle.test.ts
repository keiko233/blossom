import { describe, expect, it } from "vitest";

import {
  attemptRetentionCutoff,
  isRedeemThrottled,
  REDEEM_ATTEMPT_RETENTION_MS,
  REDEEM_IP_ATTEMPT_LIMIT,
  REDEEM_THROTTLE_WINDOW_MS,
  REDEEM_USER_ATTEMPT_LIMIT,
  throttleWindowStart,
} from "./redeem-throttle";

describe("isRedeemThrottled", () => {
  it("allows attempts up to the per-user limit, then blocks", () => {
    expect(isRedeemThrottled({ user: REDEEM_USER_ATTEMPT_LIMIT, ip: 1 })).toBe(
      false,
    );
    expect(
      isRedeemThrottled({ user: REDEEM_USER_ATTEMPT_LIMIT + 1, ip: 1 }),
    ).toBe(true);
  });

  it("blocks on the per-IP limit independently", () => {
    expect(isRedeemThrottled({ user: 1, ip: REDEEM_IP_ATTEMPT_LIMIT })).toBe(
      false,
    );
    expect(
      isRedeemThrottled({ user: 1, ip: REDEEM_IP_ATTEMPT_LIMIT + 1 }),
    ).toBe(true);
  });

  it("skips the IP check when the IP is unknown", () => {
    expect(isRedeemThrottled({ user: 1, ip: null })).toBe(false);
  });
});

describe("windows", () => {
  const now = new Date("2026-10-29T12:00:00Z");

  it("counts over the last hour", () => {
    expect(now.getTime() - throttleWindowStart(now).getTime()).toBe(
      REDEEM_THROTTLE_WINDOW_MS,
    );
  });

  it("prunes beyond the retention period, which outlasts the window", () => {
    expect(now.getTime() - attemptRetentionCutoff(now).getTime()).toBe(
      REDEEM_ATTEMPT_RETENTION_MS,
    );
    expect(REDEEM_ATTEMPT_RETENTION_MS).toBeGreaterThan(
      REDEEM_THROTTLE_WINDOW_MS,
    );
  });
});
