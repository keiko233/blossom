import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/db";

vi.mock("@/query/managed-rollout-write", () => ({
  abortManagedRollout: vi.fn(),
  findActiveManagedRolloutId: vi.fn(),
  listActiveManagedRolloutIds: vi.fn(),
  reconcileManagedRollout: vi.fn(),
  recordManagedLinkProbeResult: vi.fn(),
  recordManagedStageReport: vi.fn(),
  retryManagedRolloutStage: vi.fn(),
}));
vi.mock("@/orpc/proxy/agent-desired-state", () => ({
  buildAgentDesiredState: vi.fn(async () => ({
    desiredRevisionSeq: 4,
    desiredRevision: `4:sha256:${"a".repeat(64)}`,
  })),
}));
vi.mock("@/query/agent", () => ({
  invalidateDesiredConfigRevisions: vi.fn(async () => undefined),
}));

import {
  findActiveManagedRolloutId,
  reconcileManagedRollout,
  recordManagedLinkProbeResult,
  recordManagedStageReport,
} from "@/query/managed-rollout-write";

import {
  applyManagedConfigAck,
  applyManagedHello,
  applyManagedProbeResult,
  applyManagedStatus,
} from "./managed-rollout-runtime";

const FINGERPRINT = `sha256:${"d".repeat(64)}`;
const REVISION = `3:sha256:${"a".repeat(64)}`;

function fakeDatabase(row: {
  appliedRevisionSeq: number;
  wsSessionId: string | null;
  agentCapabilities?: string[];
}): Database {
  return {
    select: () => ({
      from: () => ({
        where: async () => [
          {
            id: "srv-a",
            enabled: true,
            assignedRevisionSeq: 3,
            agentCapabilities: [],
            ...row,
          },
        ],
      }),
    }),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordManagedStageReport).mockResolvedValue({
    ok: true,
    action: "ignored",
    reason: "no_active_rollout",
  });
  vi.mocked(findActiveManagedRolloutId).mockResolvedValue(null);
  vi.mocked(reconcileManagedRollout).mockResolvedValue({
    ok: true,
    action: "none",
    rolloutId: "rollout-1",
  });
});

describe("managed rollout session ingress", () => {
  it("forwards the authenticated ack outcome and identifier to the adapter", async () => {
    const ack = {
      desired: { desiredRevisionSeq: 3, desiredRevision: REVISION },
      outcome: "applied" as const,
    };
    await applyManagedConfigAck(
      {
        serverId: "srv-a",
        sessionId: "session-a",
        ack,
        outcome: "applied",
      },
      { activationEnabled: true },
    );
    expect(recordManagedStageReport).toHaveBeenCalledWith(
      {
        authenticatedServerId: "srv-a",
        sessionId: "session-a",
        outcome: "applied",
        desiredRevisionSeq: 3,
      },
      { database: expect.anything(), activationEnabled: true },
    );
    expect(recordManagedStageReport).toHaveBeenCalledTimes(1);
  });

  it("does not touch the store while activation is disabled", async () => {
    await applyManagedConfigAck(
      {
        serverId: "srv-a",
        sessionId: "session-a",
        ack: {
          desired: { desiredRevisionSeq: 3, desiredRevision: REVISION },
          outcome: "failed",
          stage: "apply",
          error: "rejected",
        },
        outcome: "failed",
      },
      { activationEnabled: false },
    );
    await applyManagedProbeResult(
      {
        serverId: "srv-a",
        sessionId: "session-a",
        result: {
          probeId: "probe-1",
          rolloutId: "rollout-1",
          stageOrdinal: 1,
          linkId: "link-1",
          outcome: "succeeded",
          applied: { desiredRevisionSeq: 3, managedFingerprint: FINGERPRINT },
          completedAt: "2026-11-20T00:00:00.000Z",
        },
      },
      { activationEnabled: false },
    );
    expect(recordManagedStageReport).not.toHaveBeenCalled();
    expect(recordManagedLinkProbeResult).not.toHaveBeenCalled();
  });

  it("replays the recorded applied identifier from status and hello", async () => {
    const database = fakeDatabase({
      appliedRevisionSeq: 3,
      wsSessionId: "session-a",
    });
    await applyManagedStatus(
      { serverId: "srv-a", sessionId: "session-a" },
      { activationEnabled: true, database },
    );
    expect(recordManagedStageReport).toHaveBeenCalledWith(
      {
        authenticatedServerId: "srv-a",
        sessionId: "session-a",
        outcome: "applied",
        desiredRevisionSeq: 3,
      },
      { database, activationEnabled: true },
    );

    vi.mocked(recordManagedStageReport).mockClear();
    vi.mocked(recordManagedStageReport).mockResolvedValue({
      ok: true,
      action: "confirmed",
      rolloutId: "rollout-1",
      ordinal: 1,
      revisionSeq: 3,
      managedFingerprint: FINGERPRINT,
    });
    await applyManagedHello(
      {
        serverId: "srv-a",
        sessionId: "session-a",
        applied: { desiredRevisionSeq: 3, desiredRevision: REVISION },
      },
      { activationEnabled: true, database },
    );
    expect(recordManagedStageReport).toHaveBeenCalledWith(
      {
        authenticatedServerId: "srv-a",
        sessionId: "session-a",
        outcome: "applied",
        desiredRevisionSeq: 3,
      },
      { database, activationEnabled: true },
    );
  });

  it("ignores a status from a replaced session", async () => {
    const database = fakeDatabase({
      appliedRevisionSeq: 3,
      wsSessionId: "session-new",
    });
    await applyManagedStatus(
      { serverId: "srv-a", sessionId: "session-old" },
      { activationEnabled: true, database },
    );
    expect(recordManagedStageReport).not.toHaveBeenCalled();
  });

  it("reconciles only after a probe result was recorded", async () => {
    vi.mocked(recordManagedLinkProbeResult).mockResolvedValue({
      ok: true,
      action: "rejected",
      reason: "stale_generation",
    });
    await applyManagedProbeResult({
      serverId: "srv-a",
      sessionId: "session-a",
      result: {
        probeId: "probe-1",
        rolloutId: "rollout-1",
        stageOrdinal: 1,
        linkId: "link-1",
        outcome: "succeeded",
        applied: { desiredRevisionSeq: 3, managedFingerprint: FINGERPRINT },
        completedAt: "2026-11-20T00:00:00.000Z",
      },
    });
    expect(reconcileManagedRollout).not.toHaveBeenCalled();

    vi.mocked(recordManagedLinkProbeResult).mockResolvedValue({
      ok: true,
      action: "recorded",
      probeId: "probe-1",
      outcome: "succeeded",
    });
    vi.mocked(findActiveManagedRolloutId).mockResolvedValue("rollout-1");
    await applyManagedProbeResult(
      {
        serverId: "srv-a",
        sessionId: "session-a",
        result: {
          probeId: "probe-1",
          rolloutId: "rollout-1",
          stageOrdinal: 1,
          linkId: "link-1",
          outcome: "succeeded",
          applied: { desiredRevisionSeq: 3, managedFingerprint: FINGERPRINT },
          completedAt: "2026-11-20T00:00:00.000Z",
        },
      },
      { activationEnabled: true },
    );
    expect(reconcileManagedRollout).toHaveBeenCalledTimes(1);
  });
});
