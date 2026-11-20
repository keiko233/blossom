import { describe, expect, it } from "vitest";

import {
  computeStageDeadline,
  decideRolloutAbort,
  decideRolloutStep,
  decideStageRetry,
  deriveRolloutView,
  evaluateAgentStageReport,
  evaluateClaimRelease,
  type RolloutFacts,
  type RolloutStageFacts,
} from "./managed-rollout";

const T0 = new Date("2026-11-20T00:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const FP = (name: string) => `sha256:${name.padEnd(64, "0")}`;

function stage(
  ordinal: number,
  serverId: string,
  overrides: Partial<RolloutStageFacts> = {},
): RolloutStageFacts {
  return {
    ordinal,
    serverId,
    state: "pending",
    managedFingerprint: FP(`s${ordinal}`),
    minRevisionSeq: null,
    deadlineAt: null,
    probeGate: null,
    recovery: null,
    ...overrides,
  };
}

/** Receiver B, sender A with a probe gate, then routing on A. */
function receiverFirstRollout(
  overrides: Partial<RolloutFacts> = {},
  stages: RolloutStageFacts[] = [
    stage(1, "srv-b"),
    stage(2, "srv-a", { probeGate: { linkId: "link-1", latest: null } }),
    stage(3, "srv-a"),
  ],
): RolloutFacts {
  return {
    rolloutId: "rollout-1",
    state: "applying",
    currentOrdinal: 0,
    stageCount: 3,
    failureCode: null,
    stages,
    ...overrides,
  };
}

function issue(
  rollout: RolloutFacts,
  ordinal: number,
  minRevisionSeq: number,
): RolloutFacts {
  return {
    ...rollout,
    currentOrdinal: ordinal,
    stages: rollout.stages.map((s) =>
      s.ordinal === ordinal
        ? {
            ...s,
            state: "issued",
            minRevisionSeq,
            deadlineAt: computeStageDeadline(T0),
          }
        : s,
    ),
  };
}

function withStage(
  rollout: RolloutFacts,
  ordinal: number,
  patch: Partial<RolloutStageFacts>,
): RolloutFacts {
  return {
    ...rollout,
    stages: rollout.stages.map((s) =>
      s.ordinal === ordinal ? { ...s, ...patch } : s,
    ),
  };
}

describe("receiver-first activation", () => {
  it("advances only on proof and gates the routing stage on a probe", () => {
    let rollout = receiverFirstRollout();
    expect(decideRolloutStep(rollout, T0)).toEqual({
      kind: "advance",
      expectedOrdinal: 0,
      ordinal: 1,
      notifyServerId: "srv-b",
    });

    rollout = issue(rollout, 1, 10);
    expect(decideRolloutStep(rollout, at(1))).toMatchObject({
      kind: "await_proof",
      ordinal: 1,
      serverId: "srv-b",
    });
    // The sender cannot advance while the receiver is unproven.
    expect(
      evaluateAgentStageReport({
        rollout,
        report: {
          outcome: "applied",
          serverId: "srv-a",
          desiredRevisionSeq: 99,
          managedFingerprint: FP("s2"),
        },
        currentIssuedRevisionSeq: 99,
      }),
    ).toEqual({ kind: "ignore", reason: "no_stage_for_server" });
    expect(
      evaluateAgentStageReport({
        rollout,
        report: {
          outcome: "applied",
          serverId: "srv-b",
          desiredRevisionSeq: 11,
          managedFingerprint: FP("s1"),
        },
        currentIssuedRevisionSeq: 11,
      }),
    ).toEqual({ kind: "confirm_stage", ordinal: 1 });

    rollout = withStage(rollout, 1, { state: "confirmed" });
    expect(decideRolloutStep(rollout, at(2))).toMatchObject({
      kind: "advance",
      expectedOrdinal: 1,
      notifyServerId: "srv-a",
    });

    rollout = withStage(issue(rollout, 2, 20), 2, { state: "confirmed" });
    expect(decideRolloutStep(rollout, at(3))).toEqual({
      kind: "issue_probe",
      ordinal: 2,
      linkId: "link-1",
    });

    rollout = withStage(rollout, 2, {
      probeGate: {
        linkId: "link-1",
        latest: { probeId: "probe-1", expiresAt: at(60), outcome: null },
      },
    });
    expect(decideRolloutStep(rollout, at(4))).toMatchObject({
      kind: "await_probe",
      probeId: "probe-1",
    });
    expect(deriveRolloutView(rollout, at(4)).stages[1]?.status).toBe(
      "awaiting_probe",
    );

    rollout = withStage(rollout, 2, {
      probeGate: {
        linkId: "link-1",
        latest: { probeId: "probe-1", expiresAt: at(60), outcome: "succeeded" },
      },
    });
    expect(decideRolloutStep(rollout, at(5))).toMatchObject({
      kind: "advance",
      expectedOrdinal: 2,
      ordinal: 3,
    });

    rollout = withStage(issue(rollout, 3, 30), 3, { state: "confirmed" });
    expect(decideRolloutStep(rollout, at(6))).toEqual({ kind: "complete" });
    expect(evaluateClaimRelease(rollout)).toMatchObject({
      release: false,
      reason: "rollout_active",
    });
    expect(evaluateClaimRelease({ ...rollout, state: "completed" })).toEqual({
      release: true,
    });
  });
});

describe("evaluateAgentStageReport", () => {
  const issued = issue(receiverFirstRollout(), 1, 10);
  const applied = (
    seq: number,
    fingerprint: string | null,
    serverId = "srv-b",
  ) =>
    evaluateAgentStageReport({
      rollout: issued,
      report: {
        outcome: "applied",
        serverId,
        desiredRevisionSeq: seq,
        managedFingerprint: fingerprint,
      },
      currentIssuedRevisionSeq: 12,
    });

  it("ignores stale, mismatched and foreign applied reports", () => {
    expect(applied(9, FP("s1"))).toEqual({
      kind: "ignore",
      reason: "stale_revision",
    });
    expect(applied(12, FP("other"))).toEqual({
      kind: "ignore",
      reason: "fingerprint_mismatch",
    });
    expect(applied(12, null)).toEqual({
      kind: "ignore",
      reason: "fingerprint_mismatch",
    });
    expect(applied(12, FP("s1"), "srv-c")).toEqual({
      kind: "ignore",
      reason: "no_stage_for_server",
    });
  });

  it("accepts an equivalent identifier above the minimum sequence", () => {
    // Subscriber churn moved the full identifier; stage equivalence holds.
    expect(applied(12, FP("s1"))).toEqual({
      kind: "confirm_stage",
      ordinal: 1,
    });
  });

  it("treats a replayed applied report as a duplicate", () => {
    const confirmed = withStage(issued, 1, { state: "confirmed" });
    expect(
      evaluateAgentStageReport({
        rollout: confirmed,
        report: {
          outcome: "applied",
          serverId: "srv-b",
          desiredRevisionSeq: 10,
          managedFingerprint: FP("s1"),
        },
        currentIssuedRevisionSeq: 10,
      }),
    ).toEqual({ kind: "ignore", reason: "already_confirmed" });
  });

  it("fails the stage only for the current issued identifier", () => {
    const failed = (seq: number, fingerprint: string) =>
      evaluateAgentStageReport({
        rollout: issued,
        report: {
          outcome: "failed",
          serverId: "srv-b",
          desiredRevisionSeq: seq,
          issuedManagedFingerprint: fingerprint,
        },
        currentIssuedRevisionSeq: 12,
      });
    expect(failed(12, FP("s1"))).toEqual({
      kind: "fail_stage",
      compensation: {
        rolloutId: "rollout-1",
        ordinal: 1,
        failureCode: "stage_apply_failed",
      },
    });
    expect(failed(11, FP("s1"))).toEqual({
      kind: "ignore",
      reason: "not_current_identifier",
    });
    expect(failed(12, FP("old-attempt"))).toEqual({
      kind: "ignore",
      reason: "candidate_fenced",
    });
  });

  it("ignores reports for finished rollouts", () => {
    expect(
      evaluateAgentStageReport({
        rollout: { ...issued, state: "aborted" },
        report: {
          outcome: "applied",
          serverId: "srv-b",
          desiredRevisionSeq: 12,
          managedFingerprint: FP("s1"),
        },
        currentIssuedRevisionSeq: 12,
      }),
    ).toEqual({ kind: "ignore", reason: "rollout_inactive" });
  });
});

describe("deadlines and retry", () => {
  const issued = issue(receiverFirstRollout(), 1, 10);
  const deadline = computeStageDeadline(T0);

  it("derives stalled from the persisted deadline with every agent offline", () => {
    const after = new Date(deadline.getTime() + 1);
    expect(decideRolloutStep(issued, after)).toEqual({
      kind: "stalled",
      ordinal: 1,
      serverId: "srv-b",
      since: deadline,
    });
    const view = deriveRolloutView(issued, after);
    expect(view.status).toBe("stalled");
    expect(view.stages[0]?.status).toBe("stalled");
    expect(view.actions).toEqual({ retry: true, abort: true });
    expect(view.claimsHeld).toBe(true);
  });

  it("retries by moving the deadline, never the pointer", () => {
    const now = new Date(deadline.getTime() + 5_000);
    expect(decideStageRetry(issued, at(1))).toEqual({
      kind: "reject",
      reason: "not_retryable",
    });
    expect(decideStageRetry(issued, now)).toEqual({
      kind: "extend_deadline",
      ordinal: 1,
      deadlineAt: computeStageDeadline(now),
      notifyServerId: "srv-b",
    });
  });

  it("blocks on a failed or expired probe until retried", () => {
    const base = withStage(issue(receiverFirstRollout(), 2, 20), 1, {
      state: "confirmed",
    });
    const expired = withStage(base, 2, {
      state: "confirmed",
      probeGate: {
        linkId: "link-1",
        latest: { probeId: "probe-1", expiresAt: at(60), outcome: null },
      },
    });
    expect(decideRolloutStep(expired, at(61))).toMatchObject({
      kind: "probe_blocked",
      state: "expired",
    });
    expect(decideStageRetry(expired, at(61))).toEqual({
      kind: "reissue_probe",
      ordinal: 2,
      linkId: "link-1",
    });
    expect(deriveRolloutView(expired, at(61)).stages[1]?.status).toBe(
      "probe_failed",
    );
  });
});

describe("failure, abort and recovery", () => {
  it("finishes an abort directly when nothing was issued", () => {
    expect(decideRolloutAbort(receiverFirstRollout())).toEqual({
      kind: "finish_aborted",
    });
  });

  it("aborts during apply and recovers in reverse order before releasing claims", () => {
    // Stage 1 confirmed on B, stage 2 issued on A when the operator aborts.
    let rollout = issue(
      withStage(receiverFirstRollout(), 1, {
        state: "confirmed",
        minRevisionSeq: 10,
      }),
      2,
      20,
    );
    expect(decideRolloutAbort(rollout)).toEqual({
      kind: "compensate",
      compensation: {
        rolloutId: "rollout-1",
        ordinal: 2,
        failureCode: "aborted",
      },
    });

    // Task 06 compensation: stage 2 failed, pointer restored, ordinal 1.
    rollout = withStage(
      {
        ...rollout,
        state: "recovering",
        currentOrdinal: 1,
        failureCode: "aborted",
      },
      2,
      {
        state: "failed",
        recovery: {
          minRevisionSeq: 21,
          managedFingerprint: FP("a0"),
          provenAt: null,
        },
      },
    );
    expect(decideRolloutAbort(rollout)).toEqual({
      kind: "reject",
      reason: "already_recovering",
    });
    expect(decideRolloutStep(rollout, at(1))).toEqual({
      kind: "await_recovery",
      ordinal: 2,
      serverId: "srv-a",
    });
    // The candidate may still be serving; its late ACK proves nothing.
    expect(
      evaluateAgentStageReport({
        rollout,
        report: {
          outcome: "applied",
          serverId: "srv-a",
          desiredRevisionSeq: 21,
          managedFingerprint: FP("s2"),
        },
        currentIssuedRevisionSeq: 21,
      }),
    ).toEqual({ kind: "ignore", reason: "fingerprint_mismatch" });
    expect(
      evaluateAgentStageReport({
        rollout,
        report: {
          outcome: "applied",
          serverId: "srv-a",
          desiredRevisionSeq: 21,
          managedFingerprint: FP("a0"),
        },
        currentIssuedRevisionSeq: 21,
      }),
    ).toEqual({ kind: "prove_recovery", ordinal: 2 });
    expect(
      evaluateClaimRelease({ ...rollout, state: "aborted" }),
    ).toMatchObject({
      release: false,
    });

    // Sender recovered: now the receiver admission can be cleaned up.
    rollout = withStage(rollout, 2, {
      recovery: {
        minRevisionSeq: 21,
        managedFingerprint: FP("a0"),
        provenAt: at(2),
      },
    });
    expect(decideRolloutStep(rollout, at(3))).toEqual({
      kind: "compensate",
      compensation: {
        rolloutId: "rollout-1",
        ordinal: 1,
        failureCode: "aborted",
      },
    });

    // Receiver restored to the legacy snapshot (null fingerprint).
    rollout = withStage({ ...rollout, currentOrdinal: 0 }, 1, {
      state: "failed",
      recovery: {
        minRevisionSeq: 11,
        managedFingerprint: null,
        provenAt: null,
      },
    });
    expect(
      evaluateAgentStageReport({
        rollout,
        report: {
          outcome: "applied",
          serverId: "srv-b",
          desiredRevisionSeq: 11,
          managedFingerprint: null,
        },
        currentIssuedRevisionSeq: 11,
      }),
    ).toEqual({ kind: "prove_recovery", ordinal: 1 });

    rollout = withStage(rollout, 1, {
      recovery: {
        minRevisionSeq: 11,
        managedFingerprint: null,
        provenAt: at(4),
      },
    });
    expect(decideRolloutStep(rollout, at(5))).toEqual({
      kind: "finish_recovery",
      finalState: "aborted",
    });
    expect(evaluateClaimRelease({ ...rollout, state: "aborted" })).toEqual({
      release: true,
    });
  });

  it("surfaces a rejected recovery target without advancing", () => {
    const rollout = withStage(
      {
        ...issue(receiverFirstRollout(), 1, 10),
        state: "recovering",
        currentOrdinal: 0,
        failureCode: "stage_apply_failed",
      },
      1,
      {
        state: "failed",
        recovery: {
          minRevisionSeq: 11,
          managedFingerprint: null,
          provenAt: null,
        },
      },
    );
    expect(
      evaluateAgentStageReport({
        rollout,
        report: {
          outcome: "failed",
          serverId: "srv-b",
          desiredRevisionSeq: 11,
          issuedManagedFingerprint: null,
        },
        currentIssuedRevisionSeq: 11,
      }),
    ).toEqual({ kind: "recovery_apply_failed", ordinal: 1 });
    expect(deriveRolloutView(rollout, at(1))).toMatchObject({
      status: "recovering",
      actions: { retry: false, abort: false },
      claimsHeld: true,
    });
  });
});
