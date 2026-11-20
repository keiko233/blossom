import type {
  ManagedRolloutState,
  ManagedStageState,
} from "./managed-networking";

/**
 * Pure rollout transitions for managed networking (Task 08: rollout and link
 * probe). Nothing here reads or writes the database, sends notifications or
 * talks to an agent. Callers load facts, ask for a decision, and carry it out
 * through the Task 06 stage writer (`commitStage`, `compensateStage`,
 * `releaseManagedRolloutClaims`) and the existing per-server notification path.
 *
 * Stage states follow the design, not the current Task 06 write:
 *  - `pending`: the pointer has not moved to this stage.
 *  - `issued`: the pointer advanced; the stage waits for authenticated proof.
 *  - `confirmed`: an authenticated applied report proved the stage.
 *  - `failed`: compensated (failure, abort or reverse-order cleanup).
 *  - `superseded`: never issued and no longer reachable.
 * A timeout never proves an apply and never authorizes cleanup.
 */

export const MANAGED_STAGE_DEADLINE_POLICY = {
  /** Window for an issued stage to be proven before it reads as stalled. */
  stageProofSeconds: 15 * 60,
  /** Default link-probe lifetime; the contract caps it independently. */
  linkProbeSeconds: 60,
} as const;

/** Rollout failure codes persisted with a compensation. */
export const MANAGED_ROLLOUT_FAILURE_CODES = [
  "aborted",
  "stage_apply_failed",
] as const;
export type ManagedRolloutFailureCode =
  (typeof MANAGED_ROLLOUT_FAILURE_CODES)[number];

const ACTIVE_ROLLOUT_STATES: ReadonlySet<ManagedRolloutState> = new Set([
  "applying",
  "stalled",
  "recovering",
]);

// --- Facts --------------------------------------------------------------------

export type LinkProbeGateState = "pending" | "succeeded" | "failed" | "expired";

/**
 * A link probe that must succeed after this stage is proven and before the
 * next stage advances (the sender stage in receiver-first activation).
 */
export interface LinkProbeGateFacts {
  linkId: string;
  /** Latest probe issued for this stage attempt; null before the first. */
  latest: {
    probeId: string;
    expiresAt: Date;
    /** Null until an authenticated, correlated result is recorded. */
    outcome: "succeeded" | "failed" | null;
  } | null;
}

/**
 * Recovery target written by a compensation: the restored version's sequence
 * floor and fingerprint (null restores the legacy snapshot).
 */
export interface StageRecoveryFacts {
  minRevisionSeq: number;
  managedFingerprint: string | null;
  provenAt: Date | null;
}

export interface RolloutStageFacts {
  ordinal: number;
  serverId: string;
  state: ManagedStageState;
  managedFingerprint: string;
  /** `server.desired_revision_seq` at pointer advance; null while pending. */
  minRevisionSeq: number | null;
  deadlineAt: Date | null;
  probeGate: LinkProbeGateFacts | null;
  /** Non-null once a compensation restored this stage's server. */
  recovery: StageRecoveryFacts | null;
}

export interface RolloutFacts {
  rolloutId: string;
  state: ManagedRolloutState;
  /** Highest ordinal whose pointer is advanced (walks down while recovering). */
  currentOrdinal: number;
  stageCount: number;
  failureCode: string | null;
  stages: readonly RolloutStageFacts[];
}

function stageAt(
  rollout: RolloutFacts,
  ordinal: number,
): RolloutStageFacts | undefined {
  return rollout.stages.find((stage) => stage.ordinal === ordinal);
}

function isPastDeadline(deadlineAt: Date | null, now: Date): boolean {
  return deadlineAt !== null && now.getTime() >= deadlineAt.getTime();
}

export function computeStageDeadline(
  from: Date,
  seconds: number = MANAGED_STAGE_DEADLINE_POLICY.stageProofSeconds,
): Date {
  return new Date(from.getTime() + seconds * 1000);
}

export function summarizeLinkProbeGate(
  gate: LinkProbeGateFacts,
  now: Date,
): LinkProbeGateState | null {
  const latest = gate.latest;
  if (latest === null) return null;
  if (latest.outcome !== null) return latest.outcome;
  return isPastDeadline(latest.expiresAt, now) ? "expired" : "pending";
}

// --- Agent reports ------------------------------------------------------------

/**
 * Authenticated report from the v2 apply/status handlers. `serverId` comes
 * from the session, never the payload. An applied report is sent only after
 * durable commit and probation; reconnect status may replay it.
 */
export type AgentStageReport =
  | {
      outcome: "applied";
      serverId: string;
      desiredRevisionSeq: number;
      /** Fingerprint of the applied snapshot's `managed` extension, if any. */
      managedFingerprint: string | null;
    }
  | {
      outcome: "failed";
      serverId: string;
      desiredRevisionSeq: number;
      /**
       * Managed fingerprint the control plane issued under the failed
       * identifier, resolved by the caller from what it issued.
       */
      issuedManagedFingerprint: string | null;
    };

export type StageReportDecision =
  | { kind: "confirm_stage"; ordinal: number }
  | {
      kind: "fail_stage";
      compensation: ManagedStageCompensationRequest;
    }
  | { kind: "prove_recovery"; ordinal: number }
  | { kind: "recovery_apply_failed"; ordinal: number }
  | { kind: "ignore"; reason: StageReportIgnoreReason };

export type StageReportIgnoreReason =
  | "rollout_inactive"
  | "no_stage_for_server"
  | "already_confirmed"
  | "stale_revision"
  | "fingerprint_mismatch"
  | "not_current_identifier"
  | "candidate_fenced";

/** Input for the Task 06 `compensateStage` writer. */
export interface ManagedStageCompensationRequest {
  rolloutId: string;
  ordinal: number;
  failureCode: ManagedRolloutFailureCode;
}

/**
 * Same predicate as Task 07's `doesAppliedSnapshotProveStage`, extended to a
 * legacy recovery target (null fingerprint). Parity is covered by an app test.
 */
export function doesReportProve(
  target: { minRevisionSeq: number; managedFingerprint: string | null },
  applied: { desiredRevisionSeq: number; managedFingerprint: string | null },
): boolean {
  return (
    applied.desiredRevisionSeq >= target.minRevisionSeq &&
    applied.managedFingerprint === target.managedFingerprint
  );
}

/**
 * Decides what one authenticated agent report means for a rollout. Stale,
 * duplicate and fenced reports never advance it.
 *
 * @param currentIssuedRevisionSeq the server's `desired_revision_seq` now; a
 *   failure only fails the stage when it names the current identifier.
 */
export function evaluateAgentStageReport(input: {
  rollout: RolloutFacts;
  report: AgentStageReport;
  currentIssuedRevisionSeq: number;
}): StageReportDecision {
  const { rollout, report } = input;
  if (!ACTIVE_ROLLOUT_STATES.has(rollout.state)) {
    return { kind: "ignore", reason: "rollout_inactive" };
  }
  if (rollout.state === "recovering") {
    return evaluateRecoveryReport(rollout, report);
  }

  const stage = stageAt(rollout, rollout.currentOrdinal);
  if (!stage || stage.serverId !== report.serverId) {
    return { kind: "ignore", reason: "no_stage_for_server" };
  }
  if (stage.state === "confirmed") {
    return { kind: "ignore", reason: "already_confirmed" };
  }
  if (stage.state !== "issued" || stage.minRevisionSeq === null) {
    return { kind: "ignore", reason: "no_stage_for_server" };
  }
  if (report.desiredRevisionSeq < stage.minRevisionSeq) {
    return { kind: "ignore", reason: "stale_revision" };
  }

  if (report.outcome === "applied") {
    return report.managedFingerprint === stage.managedFingerprint
      ? { kind: "confirm_stage", ordinal: stage.ordinal }
      : { kind: "ignore", reason: "fingerprint_mismatch" };
  }
  if (report.desiredRevisionSeq !== input.currentIssuedRevisionSeq) {
    return { kind: "ignore", reason: "not_current_identifier" };
  }
  if (report.issuedManagedFingerprint !== stage.managedFingerprint) {
    // A material dependency re-issued the attempt; the old one is fenced.
    return { kind: "ignore", reason: "candidate_fenced" };
  }
  return {
    kind: "fail_stage",
    compensation: {
      rolloutId: rollout.rolloutId,
      ordinal: stage.ordinal,
      failureCode: "stage_apply_failed",
    },
  };
}

function evaluateRecoveryReport(
  rollout: RolloutFacts,
  report: AgentStageReport,
): StageReportDecision {
  // The most recent compensation on this server is the live recovery target.
  const step = [...rollout.stages]
    .filter(
      (stage) =>
        stage.serverId === report.serverId &&
        stage.recovery !== null &&
        stage.recovery.provenAt === null,
    )
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  if (!step?.recovery) {
    // Candidate replies after an abort may still arrive; they prove nothing.
    return { kind: "ignore", reason: "candidate_fenced" };
  }
  if (report.desiredRevisionSeq < step.recovery.minRevisionSeq) {
    return { kind: "ignore", reason: "stale_revision" };
  }
  if (report.outcome === "failed") {
    return report.issuedManagedFingerprint === step.recovery.managedFingerprint
      ? { kind: "recovery_apply_failed", ordinal: step.ordinal }
      : { kind: "ignore", reason: "candidate_fenced" };
  }
  return doesReportProve(step.recovery, report)
    ? { kind: "prove_recovery", ordinal: step.ordinal }
    : { kind: "ignore", reason: "fingerprint_mismatch" };
}

// --- Reconciler step ----------------------------------------------------------

/**
 * Next action for the reconciler, heartbeat sweep or bounded maintenance
 * entry point. Every action is idempotent against the persisted CAS tokens.
 */
export type RolloutStepDecision =
  | {
      kind: "advance";
      /** Task 06 `commitStage` CAS token; caller adds the topology token. */
      expectedOrdinal: number;
      ordinal: number;
      /** Notify after commit; notifications are best effort. */
      notifyServerId: string;
    }
  | {
      kind: "await_proof";
      ordinal: number;
      serverId: string;
      deadlineAt: Date | null;
    }
  | { kind: "stalled"; ordinal: number; serverId: string; since: Date }
  | { kind: "issue_probe"; ordinal: number; linkId: string }
  | { kind: "await_probe"; ordinal: number; linkId: string; probeId: string }
  | {
      kind: "probe_blocked";
      ordinal: number;
      linkId: string;
      state: "failed" | "expired";
    }
  | { kind: "complete" }
  | { kind: "compensate"; compensation: ManagedStageCompensationRequest }
  | { kind: "await_recovery"; ordinal: number; serverId: string }
  | { kind: "finish_recovery"; finalState: "failed" | "aborted" }
  | { kind: "none" };

export function decideRolloutStep(
  rollout: RolloutFacts,
  now: Date,
): RolloutStepDecision {
  if (!ACTIVE_ROLLOUT_STATES.has(rollout.state)) return { kind: "none" };
  if (rollout.state === "recovering") return decideRecoveryStep(rollout);

  const current =
    rollout.currentOrdinal > 0
      ? stageAt(rollout, rollout.currentOrdinal)
      : undefined;
  if (current) {
    if (current.state !== "confirmed") {
      if (current.state !== "issued") return { kind: "none" };
      if (
        current.deadlineAt !== null &&
        isPastDeadline(current.deadlineAt, now)
      ) {
        return {
          kind: "stalled",
          ordinal: current.ordinal,
          serverId: current.serverId,
          since: current.deadlineAt,
        };
      }
      return {
        kind: "await_proof",
        ordinal: current.ordinal,
        serverId: current.serverId,
        deadlineAt: current.deadlineAt,
      };
    }
    if (current.probeGate) {
      const gate = current.probeGate;
      const state = summarizeLinkProbeGate(gate, now);
      if (state === null) {
        return {
          kind: "issue_probe",
          ordinal: current.ordinal,
          linkId: gate.linkId,
        };
      }
      if (state === "pending" && gate.latest) {
        return {
          kind: "await_probe",
          ordinal: current.ordinal,
          linkId: gate.linkId,
          probeId: gate.latest.probeId,
        };
      }
      if (state === "failed" || state === "expired") {
        return {
          kind: "probe_blocked",
          ordinal: current.ordinal,
          linkId: gate.linkId,
          state,
        };
      }
    }
  }

  if (rollout.currentOrdinal >= rollout.stageCount) return { kind: "complete" };
  const next = stageAt(rollout, rollout.currentOrdinal + 1);
  if (!next || next.state !== "pending") return { kind: "none" };
  return {
    kind: "advance",
    expectedOrdinal: rollout.currentOrdinal,
    ordinal: next.ordinal,
    notifyServerId: next.serverId,
  };
}

/**
 * Reverse-order cleanup. Task 06 compensation leaves `currentOrdinal` at the
 * compensated ordinal minus one, so the next step is that ordinal once every
 * higher compensated stage has proven its recovery target.
 */
function decideRecoveryStep(rollout: RolloutFacts): RolloutStepDecision {
  const unproven = rollout.stages
    .filter((stage) => stage.recovery && stage.recovery.provenAt === null)
    .sort((a, b) => b.ordinal - a.ordinal);
  const blocking = unproven.find(
    (stage) => stage.ordinal > rollout.currentOrdinal,
  );
  if (blocking) {
    return {
      kind: "await_recovery",
      ordinal: blocking.ordinal,
      serverId: blocking.serverId,
    };
  }
  const next =
    rollout.currentOrdinal > 0
      ? stageAt(rollout, rollout.currentOrdinal)
      : undefined;
  if (next && (next.state === "issued" || next.state === "confirmed")) {
    return {
      kind: "compensate",
      compensation: {
        rolloutId: rollout.rolloutId,
        ordinal: next.ordinal,
        failureCode: recoveryFailureCode(rollout),
      },
    };
  }
  if (unproven.length > 0) {
    return {
      kind: "await_recovery",
      ordinal: unproven[0].ordinal,
      serverId: unproven[0].serverId,
    };
  }
  return {
    kind: "finish_recovery",
    finalState: rollout.failureCode === "aborted" ? "aborted" : "failed",
  };
}

function recoveryFailureCode(rollout: RolloutFacts): ManagedRolloutFailureCode {
  return rollout.failureCode === "aborted" ? "aborted" : "stage_apply_failed";
}

// --- Operator actions ---------------------------------------------------------

export type RolloutAbortDecision =
  | { kind: "compensate"; compensation: ManagedStageCompensationRequest }
  /** Nothing was issued: finish as aborted and release claims directly. */
  | { kind: "finish_aborted" }
  | { kind: "reject"; reason: "rollout_inactive" | "already_recovering" };

/**
 * Audited Abort. The issued candidate may already be serving, so it is
 * compensated like a failure and stays "possibly serving" until the recovery
 * target is proven. Abort during recovery is a no-op rejection.
 */
export function decideRolloutAbort(
  rollout: RolloutFacts,
): RolloutAbortDecision {
  if (!ACTIVE_ROLLOUT_STATES.has(rollout.state)) {
    return { kind: "reject", reason: "rollout_inactive" };
  }
  if (rollout.state === "recovering") {
    return { kind: "reject", reason: "already_recovering" };
  }
  const current =
    rollout.currentOrdinal > 0
      ? stageAt(rollout, rollout.currentOrdinal)
      : undefined;
  if (!current) return { kind: "finish_aborted" };
  return {
    kind: "compensate",
    compensation: {
      rolloutId: rollout.rolloutId,
      ordinal: current.ordinal,
      failureCode: "aborted",
    },
  };
}

export type StageRetryDecision =
  | {
      kind: "extend_deadline";
      ordinal: number;
      deadlineAt: Date;
      notifyServerId: string;
    }
  | { kind: "reissue_probe"; ordinal: number; linkId: string }
  | { kind: "reject"; reason: "not_retryable" };

/**
 * Audited Retry for a stalled stage or a blocked probe. It re-notifies and
 * moves the deadline; it never moves the pointer or the sequence.
 */
export function decideStageRetry(
  rollout: RolloutFacts,
  now: Date,
): StageRetryDecision {
  const step = decideRolloutStep(rollout, now);
  if (step.kind === "stalled") {
    return {
      kind: "extend_deadline",
      ordinal: step.ordinal,
      deadlineAt: computeStageDeadline(now),
      notifyServerId: step.serverId,
    };
  }
  if (step.kind === "probe_blocked") {
    return {
      kind: "reissue_probe",
      ordinal: step.ordinal,
      linkId: step.linkId,
    };
  }
  return { kind: "reject", reason: "not_retryable" };
}

// --- Claim release ------------------------------------------------------------

export type ClaimReleaseDecision =
  | { release: true }
  | {
      release: false;
      reason:
        | "rollout_active"
        | "awaiting_stage_proof"
        | "awaiting_recovery_proof";
      serverIds: string[];
    };

/**
 * Claims stay until proof shows which routes and credentials remain active:
 * every stage confirmed on completion, or every compensated stage's recovery
 * target proven after failure or abort. Stalled time never releases them.
 */
export function evaluateClaimRelease(
  rollout: RolloutFacts,
): ClaimReleaseDecision {
  const servers = (stages: readonly RolloutStageFacts[]) => [
    ...new Set(stages.map((stage) => stage.serverId)),
  ];
  if (ACTIVE_ROLLOUT_STATES.has(rollout.state)) {
    return {
      release: false,
      reason: "rollout_active",
      serverIds: servers(rollout.stages),
    };
  }
  const issued = rollout.stages.filter((stage) => stage.state === "issued");
  if (issued.length > 0) {
    return {
      release: false,
      reason: "awaiting_stage_proof",
      serverIds: servers(issued),
    };
  }
  // Completed: every stage proven. Failed/aborted: nothing left serving the
  // candidate, so every advanced stage was compensated and recovered.
  const blocking = rollout.stages.filter((stage) =>
    rollout.state === "completed"
      ? stage.state !== "confirmed"
      : stage.state === "confirmed" ||
        (stage.recovery !== null && stage.recovery.provenAt === null),
  );
  if (blocking.length === 0) return { release: true };
  return {
    release: false,
    reason:
      rollout.state === "completed"
        ? "awaiting_stage_proof"
        : "awaiting_recovery_proof",
    serverIds: servers(blocking),
  };
}

// --- View model (Task 09) -----------------------------------------------------

export type RolloutStageViewStatus =
  | "pending"
  | "awaiting_proof"
  | "stalled"
  | "awaiting_probe"
  | "probe_failed"
  | "confirmed"
  | "recovering"
  | "recovered"
  | "superseded";

export type RolloutViewStatus =
  | "applying"
  | "stalled"
  | "recovering"
  | "completed"
  | "failed"
  | "aborted";

export interface RolloutView {
  status: RolloutViewStatus;
  lastConfirmedOrdinal: number;
  stages: {
    ordinal: number;
    serverId: string;
    status: RolloutStageViewStatus;
    deadlineAt: Date | null;
  }[];
  actions: { retry: boolean; abort: boolean };
  claimsHeld: boolean;
}

/**
 * Read model derived only from persisted facts and `now`, so stalled status
 * shows even with every agent offline. Peer health is not part of it.
 */
export function deriveRolloutView(
  rollout: RolloutFacts,
  now: Date,
): RolloutView {
  const step = decideRolloutStep(rollout, now);
  const stages = [...rollout.stages]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((stage) => ({
      ordinal: stage.ordinal,
      serverId: stage.serverId,
      status: stageViewStatus(stage, now),
      deadlineAt: stage.deadlineAt,
    }));
  const lastConfirmedOrdinal = Math.max(
    0,
    ...rollout.stages
      .filter((stage) => stage.state === "confirmed" && stage.recovery === null)
      .map((stage) => stage.ordinal),
  );
  const status: RolloutViewStatus =
    rollout.state === "applying" && step.kind === "stalled"
      ? "stalled"
      : rollout.state;
  const active = rollout.state === "applying" || rollout.state === "stalled";
  return {
    status,
    lastConfirmedOrdinal,
    stages,
    actions: {
      retry: active && decideStageRetry(rollout, now).kind !== "reject",
      abort: active,
    },
    claimsHeld: !evaluateClaimRelease(rollout).release,
  };
}

function stageViewStatus(
  stage: RolloutStageFacts,
  now: Date,
): RolloutStageViewStatus {
  if (stage.recovery !== null) {
    return stage.recovery.provenAt === null ? "recovering" : "recovered";
  }
  switch (stage.state) {
    case "pending":
      return "pending";
    case "issued":
      return isPastDeadline(stage.deadlineAt, now)
        ? "stalled"
        : "awaiting_proof";
    case "confirmed": {
      if (!stage.probeGate) return "confirmed";
      const gate = summarizeLinkProbeGate(stage.probeGate, now);
      if (gate === "succeeded") return "confirmed";
      return gate === "failed" || gate === "expired"
        ? "probe_failed"
        : "awaiting_probe";
    }
    case "failed":
      return "recovering";
    case "superseded":
      return "superseded";
  }
}
