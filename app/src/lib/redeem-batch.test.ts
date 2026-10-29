import { describe, expect, it } from "vitest";

import {
  getRedeemBatchStatus,
  parseIntInRange,
  resolveRedeemDurationDays,
  totalRedeemUses,
} from "./redeem-batch";

const now = new Date("2026-10-29T00:00:00Z");
const base = {
  disabled: false,
  expiresAt: null,
  codeCount: 10,
  redeemed: 3,
  maxRedemptionsPerCode: 2,
};

describe("getRedeemBatchStatus", () => {
  it("is active while uses remain", () => {
    expect(getRedeemBatchStatus(base, now)).toBe("active");
  });

  it("is disabled whatever else is true", () => {
    expect(
      getRedeemBatchStatus(
        { ...base, disabled: true, expiresAt: new Date("2020-01-01") },
        now,
      ),
    ).toBe("disabled");
  });

  it("is expired once expiresAt is reached (exclusive)", () => {
    expect(getRedeemBatchStatus({ ...base, expiresAt: now }, now)).toBe(
      "expired",
    );
    expect(
      getRedeemBatchStatus(
        { ...base, expiresAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBe("active");
  });

  it("is exhausted when every use is taken", () => {
    expect(getRedeemBatchStatus({ ...base, redeemed: 20 }, now)).toBe(
      "exhausted",
    );
    expect(getRedeemBatchStatus({ ...base, redeemed: 19 }, now)).toBe("active");
  });

  it("is never exhausted with no codes", () => {
    expect(
      getRedeemBatchStatus({ ...base, codeCount: 0, redeemed: 0 }, now),
    ).toBe("active");
  });
});

describe("helpers", () => {
  it("totals uses", () => {
    expect(totalRedeemUses(10, 2)).toBe(20);
  });

  it("falls back to the plan's duration", () => {
    expect(
      resolveRedeemDurationDays({ durationDays: null }, { durationDays: 30 }),
    ).toBe(30);
    expect(
      resolveRedeemDurationDays({ durationDays: 7 }, { durationDays: 30 }),
    ).toBe(7);
  });
});

describe("parseIntInRange", () => {
  it("accepts whole numbers inside the range", () => {
    expect(parseIntInRange("1", 1, 10)).toBe(1);
    expect(parseIntInRange(" 10 ", 1, 10)).toBe(10);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "0", "11", "1.5", "-1", "1e2", "abc", "1 2"]) {
      expect(parseIntInRange(bad, 1, 10), bad).toBeNull();
    }
  });
});
