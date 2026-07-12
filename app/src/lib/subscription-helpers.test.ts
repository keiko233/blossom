import { describe, expect, it } from "vitest";

import {
  buildSubscriptionUrl,
  getEffectiveSubscriptionStatus,
  isQuotaExhausted,
  isSubscriptionActive,
  isSubscriptionExpired,
  isSubscriptionUsable,
} from "./subscription-helpers";

const future = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const past = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

function sub(
  status: "active" | "expired" | "cancelled",
  expiresAt: string,
  quota: number,
  used: number,
) {
  return {
    status,
    expiresAt,
    trafficQuotaBytes: quota,
    trafficUsedBytes: used,
  };
}

describe("getEffectiveSubscriptionStatus", () => {
  it("keeps cancelled regardless of date", () => {
    expect(
      getEffectiveSubscriptionStatus({
        status: "cancelled",
        expiresAt: future(1),
      }),
    ).toBe("cancelled");
  });

  it("keeps explicit expired regardless of date", () => {
    expect(
      getEffectiveSubscriptionStatus({
        status: "expired",
        expiresAt: future(1),
      }),
    ).toBe("expired");
  });

  it("shows active in-the-future subscription as active", () => {
    expect(
      getEffectiveSubscriptionStatus({
        status: "active",
        expiresAt: future(1),
      }),
    ).toBe("active");
  });

  it("shows active but passed subscription as expired", () => {
    expect(
      getEffectiveSubscriptionStatus({ status: "active", expiresAt: past(1) }),
    ).toBe("expired");
  });

  it("shows active at-boundary subscription as expired", () => {
    expect(
      getEffectiveSubscriptionStatus({
        status: "active",
        expiresAt: new Date(),
      }),
    ).toBe("expired");
  });
});

describe("isSubscriptionActive", () => {
  it("returns true for active subscriptions in the future", () => {
    expect(isSubscriptionActive(sub("active", future(1), 100, 0))).toBe(true);
  });

  it("returns false for expired-by-status subscriptions", () => {
    expect(isSubscriptionActive(sub("expired", future(1), 100, 0))).toBe(false);
  });

  it("returns false for cancelled subscriptions", () => {
    expect(isSubscriptionActive(sub("cancelled", future(1), 100, 0))).toBe(
      false,
    );
  });

  it("returns false for active subscriptions whose date has passed", () => {
    expect(isSubscriptionActive(sub("active", past(1), 100, 0))).toBe(false);
  });
});

describe("isSubscriptionExpired", () => {
  it("returns true when expiresAt is in the past", () => {
    expect(isSubscriptionExpired(sub("active", past(1), 100, 0))).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    expect(isSubscriptionExpired(sub("active", future(1), 100, 0))).toBe(false);
  });

  it("returns true for explicit expired status even in the future", () => {
    expect(isSubscriptionExpired(sub("expired", future(1), 100, 0))).toBe(true);
  });

  it("returns false for cancelled subscriptions in the future", () => {
    expect(isSubscriptionExpired(sub("cancelled", future(1), 100, 0))).toBe(
      false,
    );
  });
});

describe("isQuotaExhausted", () => {
  it("returns false for unlimited quotas", () => {
    expect(isQuotaExhausted(sub("active", future(1), 0, 1_000_000))).toBe(
      false,
    );
  });

  it("returns false when usage is below quota", () => {
    expect(isQuotaExhausted(sub("active", future(1), 1000, 999))).toBe(false);
  });

  it("returns true when usage equals quota", () => {
    expect(isQuotaExhausted(sub("active", future(1), 1000, 1000))).toBe(true);
  });

  it("returns true when usage exceeds quota", () => {
    expect(isQuotaExhausted(sub("active", future(1), 1000, 1001))).toBe(true);
  });
});

describe("isSubscriptionUsable", () => {
  it("returns true for active, unexpired, under-quota subscriptions", () => {
    expect(isSubscriptionUsable(sub("active", future(1), 1000, 100))).toBe(
      true,
    );
  });

  it("returns false when cancelled", () => {
    expect(isSubscriptionUsable(sub("cancelled", future(1), 1000, 100))).toBe(
      false,
    );
  });

  it("returns false when expired by date", () => {
    expect(isSubscriptionUsable(sub("active", past(1), 1000, 100))).toBe(false);
  });

  it("returns false when quota is exhausted", () => {
    expect(isSubscriptionUsable(sub("active", future(1), 1000, 1000))).toBe(
      false,
    );
  });
});

describe("buildSubscriptionUrl", () => {
  it("builds a relative path when no origin is provided", () => {
    expect(buildSubscriptionUrl("abc123")).toBe("/api/sub/abc123");
  });

  it("builds an absolute URL when origin is provided", () => {
    expect(buildSubscriptionUrl("abc123", "https://example.com")).toBe(
      "https://example.com/api/sub/abc123",
    );
  });

  it("URL-encodes tokens containing special characters", () => {
    expect(buildSubscriptionUrl("a/b c", "https://example.com")).toBe(
      "https://example.com/api/sub/a%2Fb%20c",
    );
  });
});
