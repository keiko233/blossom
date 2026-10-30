import { describe, expect, it } from "vitest";

import { NoUsableProxiesError } from "./clash-config";
import {
  classifyDeliveryFailure,
  deliveryFailureResponse,
  PENDING_RETRY_AFTER_SECONDS,
} from "./subscription-delivery";

const noProxies = new NoUsableProxiesError([]);

describe("classifyDeliveryFailure", () => {
  it("reports no entitled nodes as a permanent 403 without Retry-After", () => {
    const failure = classifyDeliveryFailure({
      accessibleCount: 0,
      gatedCount: 0,
      error: noProxies,
    });
    expect(failure.reason).toBe("no_nodes");
    expect(failure.status).toBe(403);
    expect(failure.retryAfterSeconds).toBeUndefined();
  });

  it("reports nodes withheld by the publish gate as retryable 503", () => {
    const failure = classifyDeliveryFailure({
      accessibleCount: 2,
      gatedCount: 0,
      error: noProxies,
    });
    expect(failure.reason).toBe("pending_deployment");
    expect(failure.status).toBe(503);
    expect(failure.retryAfterSeconds).toBe(PENDING_RETRY_AFTER_SECONDS);
  });

  it("treats a gate-withheld node as pending even if the visible ones are unsupported", () => {
    const failure = classifyDeliveryFailure({
      accessibleCount: 3,
      gatedCount: 2,
      error: noProxies,
    });
    expect(failure.reason).toBe("pending_deployment");
  });

  it("reports unsupported-only nodes as non-retryable 422", () => {
    const failure = classifyDeliveryFailure({
      accessibleCount: 2,
      gatedCount: 2,
      error: noProxies,
    });
    expect(failure.reason).toBe("unsupported_nodes");
    expect(failure.status).toBe(422);
    expect(failure.retryAfterSeconds).toBeUndefined();
  });

  it("reports unexpected errors as 500 without Retry-After or details", () => {
    const failure = classifyDeliveryFailure({
      accessibleCount: 2,
      gatedCount: 2,
      error: new Error("boom: uuid=550e8400"),
    });
    expect(failure.reason).toBe("generation_failed");
    expect(failure.status).toBe(500);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.body).not.toContain("550e8400");
  });

  it("classifies an unexpected error as a bug even with no nodes", () => {
    const failure = classifyDeliveryFailure({
      accessibleCount: 0,
      gatedCount: 0,
      error: new TypeError("x"),
    });
    expect(failure.reason).toBe("generation_failed");
  });
});

describe("deliveryFailureResponse", () => {
  it("sets Retry-After only when retrying can help, and never caches", async () => {
    const pending = deliveryFailureResponse(
      classifyDeliveryFailure({
        accessibleCount: 1,
        gatedCount: 0,
        error: noProxies,
      }),
    );
    expect(pending.status).toBe(503);
    expect(pending.headers.get("Retry-After")).toBe("30");
    expect(pending.headers.get("Cache-Control")).toBe("no-store");
    expect(await pending.text()).toBe("Configuration is being deployed");

    const unsupported = deliveryFailureResponse(
      classifyDeliveryFailure({
        accessibleCount: 1,
        gatedCount: 1,
        error: noProxies,
      }),
    );
    expect(unsupported.headers.get("Retry-After")).toBeNull();
    expect(unsupported.headers.get("Cache-Control")).toBe("no-store");
  });
});
