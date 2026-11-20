import { describe, expect, it } from "vitest";

import {
  correlateLinkProbeResult,
  MANAGED_LINK_PROBE_CAPABILITY,
  managedLinkProbeRequestSchema,
  managedLinkProbeResultSchema,
  type ManagedLinkProbeRequest,
  type ManagedLinkProbeResult,
  supportsLinkProbe,
} from "./managed-link-probe";

const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

const request: ManagedLinkProbeRequest = {
  probeId: "probe-1",
  rolloutId: "rollout-1",
  stageOrdinal: 2,
  linkId: "link-1",
  credentialGeneration: 1,
  source: { serverId: "srv-a", managedFingerprint: FP_A, minRevisionSeq: 20 },
  destination: {
    serverId: "srv-b",
    managedFingerprint: FP_B,
    minRevisionSeq: 10,
  },
  issuedAt: "2026-11-20T00:00:00.000Z",
  expiresAt: "2026-11-20T00:01:00.000Z",
};

const result: ManagedLinkProbeResult = {
  probeId: "probe-1",
  rolloutId: "rollout-1",
  stageOrdinal: 2,
  linkId: "link-1",
  outcome: "succeeded",
  applied: { desiredRevisionSeq: 21, managedFingerprint: FP_A },
  latencyMs: 42,
  completedAt: "2026-11-20T00:00:05.000Z",
};

function correlate(
  overrides: Partial<Parameters<typeof correlateLinkProbeResult>[0]> = {},
) {
  return correlateLinkProbeResult({
    request,
    currentProbeId: "probe-1",
    authenticatedServerId: "srv-a",
    result,
    receivedAt: new Date("2026-11-20T00:00:06Z"),
    recordedOutcome: null,
    ...overrides,
  });
}

describe("managed link probe schemas", () => {
  it("accepts a bounded request and result", () => {
    expect(managedLinkProbeRequestSchema.parse(request)).toEqual(request);
    expect(managedLinkProbeResultSchema.parse(result)).toEqual(result);
  });

  it("rejects unbounded lifetimes, self probes and free-form outcomes", () => {
    expect(
      managedLinkProbeRequestSchema.safeParse({
        ...request,
        expiresAt: "2026-11-20T00:05:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      managedLinkProbeRequestSchema.safeParse({
        ...request,
        destination: { ...request.destination, serverId: "srv-a" },
      }).success,
    ).toBe(false);
    expect(
      managedLinkProbeResultSchema.safeParse({
        ...result,
        outcome: "connect refused by 10.0.0.2:443",
      }).success,
    ).toBe(false);
    expect(
      managedLinkProbeResultSchema.safeParse({ ...result, latencyMs: 600_000 })
        .success,
    ).toBe(false);
  });
});

describe("correlateLinkProbeResult", () => {
  it("records an authenticated result for the current probe", () => {
    expect(correlate()).toEqual({ kind: "record", outcome: "succeeded" });
    expect(correlate({ result: { ...result, outcome: "tls_failed" } })).toEqual(
      { kind: "record", outcome: "tls_failed" },
    );
  });

  it("accepts results only from the source server session", () => {
    expect(correlate({ authenticatedServerId: "srv-b" })).toEqual({
      kind: "reject",
      reason: "wrong_server",
    });
  });

  it("rejects mismatched, superseded and expired results", () => {
    expect(correlate({ result: { ...result, stageOrdinal: 3 } })).toEqual({
      kind: "reject",
      reason: "correlation_mismatch",
    });
    expect(correlate({ currentProbeId: "probe-2" })).toEqual({
      kind: "reject",
      reason: "superseded_probe",
    });
    expect(
      correlate({ receivedAt: new Date("2026-11-20T00:01:00.001Z") }),
    ).toEqual({ kind: "reject", reason: "expired" });
  });

  it("binds success to the applied source generation", () => {
    expect(
      correlate({
        result: {
          ...result,
          applied: { desiredRevisionSeq: 19, managedFingerprint: FP_A },
        },
      }),
    ).toEqual({ kind: "reject", reason: "stale_generation" });
    expect(
      correlate({
        result: {
          ...result,
          applied: { desiredRevisionSeq: 21, managedFingerprint: null },
        },
      }),
    ).toEqual({ kind: "reject", reason: "stale_generation" });
  });

  it("is idempotent per probe", () => {
    expect(correlate({ recordedOutcome: "succeeded" })).toEqual({
      kind: "duplicate",
    });
    expect(correlate({ recordedOutcome: "timeout" })).toEqual({
      kind: "reject",
      reason: "conflicting_result",
    });
  });
});

describe("supportsLinkProbe", () => {
  it("requires the capability on both ends", () => {
    const capable = [MANAGED_LINK_PROBE_CAPABILITY];
    expect(supportsLinkProbe(capable, capable)).toBe(true);
    expect(supportsLinkProbe(capable, [])).toBe(false);
  });
});
