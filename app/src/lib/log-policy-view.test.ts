import { describe, expect, it } from "vitest";

import type { ServerLogPolicySourceView } from "@/query/log-policy";

import {
  hasTemporaryLogPolicyRequest,
  logPolicyCues,
  temporarySecondsFromMinutes,
} from "./log-policy-view";

function sourceView(
  overrides: Partial<ServerLogPolicySourceView> = {},
): ServerLogPolicySourceView {
  return {
    source: "agent",
    present: true,
    desiredRevision: 2,
    desiredBaseline: "warn",
    desiredLevel: "warn",
    desiredDeadline: null,
    expired: false,
    targetLevel: "warn",
    effectiveRevision: 2,
    effectiveLevel: "warn",
    effectiveBaseline: "warn",
    effectiveDeadline: null,
    effectiveError: null,
    effectivePending: false,
    effectiveAt: new Date("2026-11-19T00:00:00.000Z"),
    pending: false,
    ...overrides,
  };
}

describe("log policy cues", () => {
  it("marks an agent without the capability as unsupported", () => {
    expect(
      logPolicyCues({
        view: sourceView(),
        capability: false,
        enabled: true,
        offline: false,
      }),
    ).toEqual(["unsupported", "in-sync"]);
  });

  it("reports offline, pending and applying independently", () => {
    expect(
      logPolicyCues({
        view: sourceView({
          effectiveRevision: 1,
          effectivePending: true,
          pending: true,
        }),
        capability: true,
        enabled: true,
        offline: true,
      }),
    ).toEqual(["offline", "pending", "applying"]);
  });

  it("keeps an apply error visible alongside a pending revision", () => {
    expect(
      logPolicyCues({
        view: sourceView({
          effectiveRevision: 1,
          effectiveError: "reload failed",
          pending: true,
        }),
        capability: true,
        enabled: true,
        offline: false,
      }),
    ).toEqual(["pending", "error"]);
  });

  it("reports in-sync only when the current revision was acknowledged", () => {
    expect(
      logPolicyCues({
        view: sourceView(),
        capability: true,
        enabled: true,
        offline: false,
      }),
    ).toEqual(["in-sync"]);
    expect(
      logPolicyCues({
        view: sourceView({ effectiveRevision: null, effectiveLevel: null }),
        capability: true,
        enabled: true,
        offline: false,
      }),
    ).toEqual(["not-reported"]);
  });

  it("can show disabled and offline for the same source", () => {
    expect(
      logPolicyCues({
        view: sourceView(),
        capability: true,
        enabled: false,
        offline: true,
      }),
    ).toEqual(["disabled", "offline", "in-sync"]);
  });
});

describe("temporary log policy state", () => {
  it("treats an expired request as an override until it is cleared", () => {
    expect(
      hasTemporaryLogPolicyRequest(
        sourceView({ desiredLevel: "default", expired: true }),
      ),
    ).toBe(true);
    expect(
      hasTemporaryLogPolicyRequest(
        sourceView({ desiredLevel: "debug", expired: false }),
      ),
    ).toBe(true);
    expect(hasTemporaryLogPolicyRequest(sourceView())).toBe(false);
  });

  it("converts bounded minute drafts to seconds", () => {
    expect(temporarySecondsFromMinutes("15")).toBe(900);
    expect(temporarySecondsFromMinutes("0.5")).toBe(30);
    expect(temporarySecondsFromMinutes("60")).toBe(3_600);
    expect(temporarySecondsFromMinutes("0")).toBeNull();
    expect(temporarySecondsFromMinutes("61")).toBeNull();
    expect(temporarySecondsFromMinutes("abc")).toBeNull();
    expect(temporarySecondsFromMinutes("")).toBeNull();
  });
});
