import {
  correlateLinkProbeResult,
  MANAGED_LINK_PROBE_LIMITS,
  type ManagedLinkProbeOutcome,
  type ManagedLinkProbeRequest,
  type ManagedLinkProbeResult,
  managedLinkProbeResultSchema,
  supportsLinkProbe,
} from "@blossom/contracts/managed-link-probe";
import { MANAGED_NETWORKING_ACTIVATION_ENABLED } from "@blossom/domain/managed-networking";
import {
  computeStageDeadline,
  decideRolloutAbort,
  decideRolloutStep,
  decideStageRetry,
  deriveRolloutView,
  evaluateAgentStageReport,
  evaluateClaimRelease,
  MANAGED_STAGE_DEADLINE_POLICY,
  type ManagedStageCompensationRequest,
  type RolloutAbortDecision,
  type RolloutFacts,
  type RolloutStageFacts,
  type RolloutStepDecision,
  type RolloutView,
  type StageReportIgnoreReason,
  type StageRetryDecision,
} from "@blossom/domain/managed-rollout";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { type Database, db } from "@/db";
import {
  managedLinkProbe,
  managedRollout,
  managedRolloutClaim,
  managedRolloutStage,
  managedServerState,
  peerInbound,
  peerLink,
  peerLinkCredential,
  type ManagedRolloutStage,
} from "@/db/managed-network-schema";
import { server } from "@/db/proxy-schema";
import {
  commitManagedStage,
  compensateManagedStage,
  readTopologyGeneration,
  releaseManagedRolloutClaims,
  type ManagedStageCommitResult,
} from "@/query/managed-topology-write";

/**
 * Control-plane transitions for managed rollouts (Task 08: rollout and link
 * probe).
 *
 * Pure decisions live in `@blossom/domain/managed-rollout` and
 * `@blossom/contracts/managed-link-probe`. This module is the only database
 * adapter: it loads persisted facts, asks the pure layer, and carries out the
 * decision with a compare-and-swap. The DB never treats a timeout, a delayed
 * report or a probe result as proof by itself.
 *
 * Not wired here yet (Task 07/09 handoff):
 *  - v2 `apply`/`status` ingress has not landed; transports call
 *    `recordManagedStageReport` with the authenticated session id.
 *  - The v2 egress that delivers `link_probe.request` is not registered in the
 *    shared message tables/OpenAPI; callers deliver the returned request.
 *  - Cross-server notification is returned as `notifyServerId` and must use
 *    the existing best-effort per-server path at the call site.
 *  - Agent-side probe isolation, the loopback ingress/responder and capability
 *    advertisement remain with the Task 07 agent work.
 *
 * Managed activation stays off by default (`MANAGED_NETWORKING_ACTIVATION_ENABLED`).
 */

const ACTIVE_ROLLOUT_STATES = ["applying", "stalled", "recovering"] as const;

export interface ManagedRolloutOptions {
  database?: Database;
  activationEnabled?: boolean;
  /** Injectable clock for maintenance sweeps and tests. */
  now?: Date;
}

interface RolloutContext {
  database: Database;
  activationEnabled: boolean;
  now: Date;
}

function resolveContext(options: ManagedRolloutOptions = {}): RolloutContext {
  return {
    database: options.database ?? db,
    activationEnabled:
      options.activationEnabled ?? MANAGED_NETWORKING_ACTIVATION_ENABLED,
    now: options.now ?? new Date(),
  };
}

async function executeRows<T extends Record<string, unknown>>(
  database: Database,
  statement: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(statement, "objects");
  if (Array.isArray(result)) return result;
  const wrapped = result as unknown as { rows?: T[] };
  return wrapped.rows ?? [];
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function timestampValue(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const text = String(value);
  // Drizzle maps a timezone-less `timestamp` as UTC. Raw neon-http rows arrive
  // as text, so apply the same interpretation instead of the host timezone.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) {
    return new Date(`${text.replace(" ", "T")}Z`);
  }
  return new Date(text);
}

function activeStatesSql() {
  return sql`(${sql.join(
    ACTIVE_ROLLOUT_STATES.map((state) => sql`${state}`),
    sql`, `,
  )})`;
}

// --- Persisted facts and stable reads ---------------------------------------

export interface ManagedRolloutSnapshot {
  rollout: typeof managedRollout.$inferSelect;
  /** Raw stage rows for adapters that need config versions or probe links. */
  rawStages: ManagedRolloutStage[];
  facts: RolloutFacts;
  claimedServerIds: string[];
  pausedServerIds: string[];
}

export interface ManagedRolloutDetail {
  rolloutId: string;
  view: RolloutView;
  claimedServerIds: string[];
  paused: boolean;
  pausedServerIds: string[];
}

function latestProbes(
  probes: readonly (typeof managedLinkProbe.$inferSelect)[],
): Map<number, typeof managedLinkProbe.$inferSelect> {
  const latest = new Map<number, typeof managedLinkProbe.$inferSelect>();
  for (const probe of probes) {
    if (!latest.has(probe.stageOrdinal)) latest.set(probe.stageOrdinal, probe);
  }
  return latest;
}

function probeGateFacts(
  stage: ManagedRolloutStage,
  latest: typeof managedLinkProbe.$inferSelect | undefined,
): RolloutStageFacts["probeGate"] {
  if (stage.probeLinkId === null) return null;
  return {
    linkId: stage.probeLinkId,
    latest: latest
      ? {
          probeId: latest.id,
          expiresAt: timestampValue(latest.expiresAt) ?? new Date(0),
          outcome:
            latest.outcome === null
              ? null
              : latest.outcome === "succeeded"
                ? "succeeded"
                : "failed",
        }
      : null,
  };
}

function stageFacts(
  stage: ManagedRolloutStage,
  latest: typeof managedLinkProbe.$inferSelect | undefined,
): RolloutStageFacts {
  const recovery =
    stage.recoveryIssuedRevisionSeq === null ||
    stage.recoveryMinRevisionSeq === null
      ? null
      : {
          minRevisionSeq: stage.recoveryMinRevisionSeq,
          managedFingerprint: stage.recoveryManagedFingerprint,
          provenAt: stage.recoveryProvenAt,
        };
  return {
    ordinal: stage.ordinal,
    serverId: stage.serverId,
    state: stage.state,
    managedFingerprint: stage.managedFingerprint,
    minRevisionSeq: stage.minRevisionSeq,
    deadlineAt: timestampValue(stage.deadlineAt),
    probeGate: probeGateFacts(stage, latest),
    recovery: recovery
      ? {
          ...recovery,
          provenAt: timestampValue(recovery.provenAt),
        }
      : null,
  };
}

/**
 * Loads the persisted facts the pure decisions consume, together with the
 * claim set and the emergency disable state of every claimed server.
 */
export async function readManagedRolloutSnapshot(
  rolloutId: string,
  database: Database = db,
): Promise<ManagedRolloutSnapshot | null> {
  const [rollout] = await database
    .select()
    .from(managedRollout)
    .where(eq(managedRollout.id, rolloutId));
  if (!rollout) return null;

  const [stages, probes, claims] = await Promise.all([
    database
      .select()
      .from(managedRolloutStage)
      .where(eq(managedRolloutStage.rolloutId, rolloutId))
      .orderBy(managedRolloutStage.ordinal),
    database
      .select()
      .from(managedLinkProbe)
      .where(eq(managedLinkProbe.rolloutId, rolloutId))
      .orderBy(
        desc(managedLinkProbe.issuedAt),
        desc(managedLinkProbe.createdAt),
        desc(managedLinkProbe.id),
      ),
    database
      .select({ serverId: managedRolloutClaim.serverId })
      .from(managedRolloutClaim)
      .where(eq(managedRolloutClaim.rolloutId, rolloutId))
      .orderBy(managedRolloutClaim.serverId),
  ]);

  const claimedServerIds = claims.map((claim) => claim.serverId);
  const servers =
    claimedServerIds.length === 0
      ? []
      : await database
          .select({ id: server.id, enabled: server.enabled })
          .from(server)
          .where(inArray(server.id, claimedServerIds));
  const pausedServerIds = servers
    .filter((row) => !row.enabled)
    .map((row) => row.id);

  const latest = latestProbes(probes);
  const facts: RolloutFacts = {
    rolloutId: rollout.id,
    state: rollout.state,
    currentOrdinal: rollout.currentOrdinal,
    stageCount: rollout.stageCount,
    failureCode: rollout.failureCode,
    stages: stages.map((stage) => stageFacts(stage, latest.get(stage.ordinal))),
  };
  return {
    rollout,
    rawStages: stages,
    facts,
    claimedServerIds,
    pausedServerIds,
  };
}

/**
 * Read model for Task 09. Stalled state is derived from the persisted deadline,
 * so it is visible while every agent is offline; peer health is not mixed in.
 */
export async function readManagedRolloutDetail(
  rolloutId: string,
  now: Date = new Date(),
  database: Database = db,
): Promise<ManagedRolloutDetail | null> {
  const snapshot = await readManagedRolloutSnapshot(rolloutId, database);
  if (!snapshot) return null;
  return {
    rolloutId,
    view: deriveRolloutView(snapshot.facts, now),
    claimedServerIds: snapshot.claimedServerIds,
    paused: snapshot.pausedServerIds.length > 0,
    pausedServerIds: snapshot.pausedServerIds,
  };
}

export async function readManagedRolloutView(
  rolloutId: string,
  now: Date = new Date(),
  database: Database = db,
): Promise<RolloutView | null> {
  return (
    (await readManagedRolloutDetail(rolloutId, now, database))?.view ?? null
  );
}

export interface ListManagedRolloutsInput {
  serverId?: string;
  limit?: number;
}

/**
 * Bounded list for the Task 09 workspace. Active rollouts update most recently;
 * every row is derived from the same reader as the detail view.
 */
export async function listManagedRolloutDetails(
  input: ListManagedRolloutsInput = {},
  now: Date = new Date(),
  database: Database = db,
): Promise<ManagedRolloutDetail[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rolloutIds = await database
    .select({ id: managedRollout.id })
    .from(managedRollout)
    .where(
      input.serverId
        ? sql`EXISTS (
            SELECT 1 FROM ${managedRolloutStage}
            WHERE ${managedRolloutStage.rolloutId} = ${managedRollout.id}
              AND ${managedRolloutStage.serverId} = ${input.serverId}::text
          )`
        : sql`TRUE`,
    )
    .orderBy(desc(managedRollout.updatedAt))
    .limit(limit);

  const details = await Promise.all(
    rolloutIds.map(({ id }) => readManagedRolloutDetail(id, now, database)),
  );
  return details.filter((detail): detail is ManagedRolloutDetail =>
    Boolean(detail),
  );
}

/** Latest linked probe rows for a rollout, with bounded outcomes only. */
export async function listManagedLinkProbes(
  rolloutId: string,
  database: Database = db,
): Promise<(typeof managedLinkProbe.$inferSelect)[]> {
  return database
    .select()
    .from(managedLinkProbe)
    .where(eq(managedLinkProbe.rolloutId, rolloutId))
    .orderBy(
      managedLinkProbe.stageOrdinal,
      desc(managedLinkProbe.issuedAt),
      desc(managedLinkProbe.createdAt),
      desc(managedLinkProbe.id),
    );
}

// --- Authenticated stage reports --------------------------------------------

export interface ManagedStageReportInput {
  /** Comes from the authenticated agent session, never from the payload. */
  authenticatedServerId: string;
  /** Exact current WebSocket session; a replaced session cannot report. */
  sessionId: string;
  outcome: "applied" | "failed";
  desiredRevisionSeq: number;
  /** Applied fingerprint; ignored for a failure report. */
  managedFingerprint?: string | null;
}

export type ManagedStageReportResult =
  | {
      ok: true;
      action: "confirmed";
      rolloutId: string;
      ordinal: number;
      revisionSeq: number;
      managedFingerprint: string;
      alreadyConfirmed?: boolean;
    }
  | {
      ok: true;
      action: "compensated";
      rolloutId: string;
      ordinal: number;
      revisionSeq: number;
      recoveryMinRevisionSeq: number | null;
      recoveryManagedFingerprint: string | null;
      recoveryDeadlineAt: Date | null;
      alreadyCompensated?: boolean;
    }
  | {
      ok: true;
      action: "recovery_proven";
      rolloutId: string;
      ordinal: number;
      managedFingerprint: string | null;
      alreadyProven?: boolean;
    }
  | {
      ok: true;
      action: "recovery_apply_failed";
      rolloutId: string;
      ordinal: number;
    }
  | {
      ok: true;
      action: "ignored";
      reason: StageReportIgnoreReason | "no_active_rollout";
    }
  | {
      ok: false;
      reason: "activation_disabled" | "session_fenced" | "stage_conflict";
    };

async function findActiveRolloutId(
  database: Database,
  serverId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ rolloutId: managedRolloutClaim.rolloutId })
    .from(managedRolloutClaim)
    .innerJoin(
      managedRollout,
      eq(managedRollout.id, managedRolloutClaim.rolloutId),
    )
    .where(
      and(
        eq(managedRolloutClaim.serverId, serverId),
        inArray(managedRollout.state, [...ACTIVE_ROLLOUT_STATES]),
      ),
    );
  return row?.rolloutId ?? null;
}

interface CurrentSessionRow {
  desiredRevisionSeq: number;
  wsSessionId: string | null;
}

async function readCurrentSession(
  database: Database,
  serverId: string,
): Promise<CurrentSessionRow | null> {
  const [row] = await database
    .select({
      desiredRevisionSeq: server.desiredRevisionSeq,
      wsSessionId: server.wsSessionId,
    })
    .from(server)
    .where(eq(server.id, serverId));
  return row ?? null;
}

async function confirmManagedStage(input: {
  database: Database;
  rolloutId: string;
  ordinal: number;
  serverId: string;
  sessionId: string;
  desiredRevisionSeq: number;
  managedFingerprint: string;
}): Promise<
  | {
      ok: true;
      revisionSeq: number;
      managedFingerprint: string;
      alreadyConfirmed?: boolean;
    }
  | { ok: false; reason: "session_fenced" | "stage_conflict" }
> {
  const rows = await executeRows<Record<string, unknown>>(
    input.database,
    sql`
      WITH report_session_guard AS (
        SELECT 1 FROM ${server}
        WHERE ${server.id} = ${input.serverId}::text
          AND ${server.wsSessionId} = ${input.sessionId}::text
      ),
      confirmed AS (
        UPDATE ${managedRolloutStage}
        SET ${sql.identifier(managedRolloutStage.state.name)} = 'confirmed',
            ${sql.identifier(managedRolloutStage.confirmedAt.name)} = now(),
            ${sql.identifier(managedRolloutStage.updatedAt.name)} = now()
        FROM ${managedRollout}
        WHERE ${managedRolloutStage.rolloutId} = ${input.rolloutId}::text
          AND ${managedRolloutStage.ordinal} = ${input.ordinal}::integer
          AND ${managedRolloutStage.serverId} = ${input.serverId}::text
          AND ${managedRolloutStage.state} = 'issued'
          AND ${managedRolloutStage.minRevisionSeq} <= ${input.desiredRevisionSeq}::integer
          AND ${managedRolloutStage.managedFingerprint} = ${input.managedFingerprint}::text
          AND ${managedRollout.id} = ${managedRolloutStage.rolloutId}
          AND ${managedRollout.currentOrdinal} = ${managedRolloutStage.ordinal}
          AND ${managedRollout.state} IN ${activeStatesSql()}
          AND EXISTS (SELECT 1 FROM report_session_guard)
        RETURNING ${managedRolloutStage}.*
      ),
      applied_pointer AS (
        UPDATE ${managedServerState}
        SET ${sql.identifier(managedServerState.appliedConfigVersionId.name)} = confirmed.config_version_id,
            ${sql.identifier(managedServerState.appliedManagedFingerprint.name)} = confirmed.managed_fingerprint,
            ${sql.identifier(managedServerState.appliedAt.name)} = now(),
            ${sql.identifier(managedServerState.updatedAt.name)} = now()
        FROM confirmed
        WHERE ${managedServerState.serverId} = confirmed.server_id
        RETURNING 1
      ),
      applied_revision AS (
        UPDATE ${server}
        SET ${sql.identifier(server.appliedRevisionSeq.name)} = GREATEST(
              ${server.appliedRevisionSeq},
              ${input.desiredRevisionSeq}::integer
            ),
            ${sql.identifier(server.updatedAt.name)} = timezone('utc', now())
        WHERE ${server.id} = ${input.serverId}::text
          AND EXISTS (SELECT 1 FROM confirmed)
        RETURNING 1
      )
      SELECT confirmed.ordinal AS ordinal,
             confirmed.issued_revision_seq AS revision_seq,
             confirmed.managed_fingerprint AS managed_fingerprint,
             confirmed.min_revision_seq AS min_revision_seq
      FROM confirmed
      WHERE EXISTS (SELECT 1 FROM applied_revision)
    `,
  );
  if (rows[0]) {
    return {
      ok: true,
      revisionSeq: numeric(rows[0].min_revision_seq),
      managedFingerprint: String(rows[0].managed_fingerprint),
    };
  }

  const [stage] = await input.database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, input.rolloutId),
        eq(managedRolloutStage.ordinal, input.ordinal),
      ),
    );
  if (
    stage?.state === "confirmed" &&
    stage.issuedRevisionSeq !== null &&
    stage.managedFingerprint === input.managedFingerprint &&
    input.desiredRevisionSeq >= (stage.minRevisionSeq ?? 0)
  ) {
    return {
      ok: true,
      revisionSeq: stage.issuedRevisionSeq,
      managedFingerprint: stage.managedFingerprint,
      alreadyConfirmed: true,
    };
  }
  const currentSession = await readCurrentSession(
    input.database,
    input.serverId,
  );
  if (!currentSession || currentSession.wsSessionId !== input.sessionId) {
    return { ok: false, reason: "session_fenced" };
  }
  return { ok: false, reason: "stage_conflict" };
}

async function proveManagedStageRecovery(input: {
  database: Database;
  rolloutId: string;
  ordinal: number;
  serverId: string;
  sessionId: string;
  desiredRevisionSeq: number;
  managedFingerprint: string | null;
}): Promise<
  | {
      ok: true;
      managedFingerprint: string | null;
      alreadyProven?: boolean;
    }
  | { ok: false; reason: "session_fenced" | "stage_conflict" }
> {
  const rows = await executeRows<Record<string, unknown>>(
    input.database,
    sql`
      WITH report_session_guard AS (
        SELECT 1 FROM ${server}
        WHERE ${server.id} = ${input.serverId}::text
          AND ${server.wsSessionId} = ${input.sessionId}::text
      ),
      proven AS (
        UPDATE ${managedRolloutStage}
        SET ${sql.identifier(managedRolloutStage.recoveryProvenAt.name)} = now(),
            ${sql.identifier(managedRolloutStage.updatedAt.name)} = now()
        FROM ${managedRollout}
        WHERE ${managedRolloutStage.rolloutId} = ${input.rolloutId}::text
          AND ${managedRolloutStage.ordinal} = ${input.ordinal}::integer
          AND ${managedRolloutStage.serverId} = ${input.serverId}::text
          AND ${managedRolloutStage.state} = 'failed'
          AND ${managedRolloutStage.recoveryIssuedRevisionSeq} IS NOT NULL
          AND ${managedRolloutStage.recoveryProvenAt} IS NULL
          AND ${managedRolloutStage.recoveryMinRevisionSeq} <= ${input.desiredRevisionSeq}::integer
          AND ${managedRolloutStage.recoveryManagedFingerprint} IS NOT DISTINCT FROM ${input.managedFingerprint}::text
          AND ${managedRollout.id} = ${managedRolloutStage.rolloutId}
          AND ${managedRollout.state} = 'recovering'
          AND EXISTS (SELECT 1 FROM report_session_guard)
        RETURNING ${managedRolloutStage}.*
      ),
      applied_pointer AS (
        UPDATE ${managedServerState}
        SET ${sql.identifier(managedServerState.appliedConfigVersionId.name)} = proven.previous_config_version_id,
            ${sql.identifier(managedServerState.appliedManagedFingerprint.name)} = proven.recovery_managed_fingerprint,
            ${sql.identifier(managedServerState.appliedAt.name)} = now(),
            ${sql.identifier(managedServerState.updatedAt.name)} = now()
        FROM proven
        WHERE ${managedServerState.serverId} = proven.server_id
        RETURNING 1
      ),
      applied_revision AS (
        UPDATE ${server}
        SET ${sql.identifier(server.appliedRevisionSeq.name)} = GREATEST(
              ${server.appliedRevisionSeq},
              ${input.desiredRevisionSeq}::integer
            ),
            ${sql.identifier(server.updatedAt.name)} = timezone('utc', now())
        WHERE ${server.id} = ${input.serverId}::text
          AND EXISTS (SELECT 1 FROM proven)
        RETURNING 1
      )
      SELECT proven.ordinal AS ordinal,
             proven.recovery_managed_fingerprint AS managed_fingerprint
      FROM proven
      WHERE EXISTS (SELECT 1 FROM applied_revision)
    `,
  );
  if (rows[0]) {
    return {
      ok: true,
      managedFingerprint:
        rows[0].managed_fingerprint === null
          ? null
          : String(rows[0].managed_fingerprint),
    };
  }

  const [stage] = await input.database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, input.rolloutId),
        eq(managedRolloutStage.ordinal, input.ordinal),
      ),
    );
  if (
    stage?.state === "failed" &&
    stage.recoveryIssuedRevisionSeq !== null &&
    stage.recoveryProvenAt !== null &&
    stage.recoveryManagedFingerprint === input.managedFingerprint
  ) {
    return {
      ok: true,
      managedFingerprint: stage.recoveryManagedFingerprint,
      alreadyProven: true,
    };
  }
  const currentSession = await readCurrentSession(
    input.database,
    input.serverId,
  );
  if (!currentSession || currentSession.wsSessionId !== input.sessionId) {
    return { ok: false, reason: "session_fenced" };
  }
  return { ok: false, reason: "stage_conflict" };
}

/**
 * One authenticated apply/status report. Applied reports confirm only an
 * issued stage at or above its sequence with the exact managed fingerprint.
 * Failure reports compensate the current issued identifier only; stale,
 * duplicate, foreign and replaced-session reports never move a pointer.
 */
export async function recordManagedStageReport(
  input: ManagedStageReportInput,
  options: ManagedRolloutOptions = {},
): Promise<ManagedStageReportResult> {
  const context = resolveContext(options);
  if (!context.activationEnabled) {
    return { ok: false, reason: "activation_disabled" };
  }
  const rolloutId = await findActiveRolloutId(
    context.database,
    input.authenticatedServerId,
  );
  if (!rolloutId) {
    return { ok: true, action: "ignored", reason: "no_active_rollout" };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readCurrentSession(
      context.database,
      input.authenticatedServerId,
    );
    if (!current || current.wsSessionId !== input.sessionId) {
      return { ok: false, reason: "session_fenced" };
    }
    const snapshot = await readManagedRolloutSnapshot(
      rolloutId,
      context.database,
    );
    if (!snapshot) {
      return { ok: true, action: "ignored", reason: "no_active_rollout" };
    }
    const issuedStage = snapshot.rawStages.find(
      (stage) => stage.ordinal === snapshot.rollout.currentOrdinal,
    );
    const report =
      input.outcome === "applied"
        ? {
            outcome: "applied" as const,
            serverId: input.authenticatedServerId,
            desiredRevisionSeq: input.desiredRevisionSeq,
            managedFingerprint: input.managedFingerprint ?? null,
          }
        : {
            outcome: "failed" as const,
            serverId: input.authenticatedServerId,
            desiredRevisionSeq: input.desiredRevisionSeq,
            issuedManagedFingerprint:
              issuedStage?.serverId === input.authenticatedServerId
                ? issuedStage.managedFingerprint
                : null,
          };
    const decision = evaluateAgentStageReport({
      rollout: snapshot.facts,
      report,
      currentIssuedRevisionSeq: current.desiredRevisionSeq,
    });

    if (decision.kind === "ignore") {
      return { ok: true, action: "ignored", reason: decision.reason };
    }
    if (decision.kind === "confirm_stage") {
      const confirmed = await confirmManagedStage({
        database: context.database,
        rolloutId,
        ordinal: decision.ordinal,
        serverId: input.authenticatedServerId,
        sessionId: input.sessionId,
        desiredRevisionSeq: input.desiredRevisionSeq,
        managedFingerprint: issuedStage?.managedFingerprint ?? "",
      });
      if (confirmed.ok) {
        return {
          ok: true,
          action: "confirmed",
          rolloutId,
          ordinal: decision.ordinal,
          revisionSeq: confirmed.revisionSeq,
          managedFingerprint: confirmed.managedFingerprint,
          alreadyConfirmed: confirmed.alreadyConfirmed,
        };
      }
      if (confirmed.reason === "session_fenced") {
        return { ok: false, reason: "session_fenced" };
      }
      continue;
    }
    if (decision.kind === "fail_stage") {
      const compensated = await compensateManagedStage(
        {
          ...decision.compensation,
          sessionId: input.sessionId,
        },
        {
          database: context.database,
          activationEnabled: true,
        },
      );
      if (!compensated.ok) {
        if (compensated.reason === "stage_conflict") continue;
        return { ok: false, reason: "stage_conflict" };
      }
      return {
        ok: true,
        action: "compensated",
        rolloutId,
        ordinal: decision.compensation.ordinal,
        revisionSeq: compensated.revisionSeq,
        recoveryMinRevisionSeq: compensated.recoveryMinRevisionSeq ?? null,
        recoveryManagedFingerprint:
          compensated.recoveryManagedFingerprint ?? null,
        recoveryDeadlineAt: compensated.recoveryDeadlineAt ?? null,
        alreadyCompensated: compensated.alreadyCompensated,
      };
    }
    if (decision.kind === "prove_recovery") {
      const proven = await proveManagedStageRecovery({
        database: context.database,
        rolloutId,
        ordinal: decision.ordinal,
        serverId: input.authenticatedServerId,
        sessionId: input.sessionId,
        desiredRevisionSeq: input.desiredRevisionSeq,
        managedFingerprint: input.managedFingerprint ?? null,
      });
      if (proven.ok) {
        return {
          ok: true,
          action: "recovery_proven",
          rolloutId,
          ordinal: decision.ordinal,
          managedFingerprint: proven.managedFingerprint,
          alreadyProven: proven.alreadyProven,
        };
      }
      if (proven.reason === "session_fenced") {
        return { ok: false, reason: "session_fenced" };
      }
      continue;
    }
    return {
      ok: true,
      action: "recovery_apply_failed",
      rolloutId,
      ordinal: decision.ordinal,
    };
  }
  return { ok: false, reason: "stage_conflict" };
}

// --- Markers of expiry, finish and claim release ----------------------------

async function markRolloutStalled(
  database: Database,
  rolloutId: string,
): Promise<void> {
  await database.execute(
    sql`
      UPDATE ${managedRollout}
      SET ${sql.identifier(managedRollout.state.name)} = 'stalled',
          ${sql.identifier(managedRollout.updatedAt.name)} = now()
      WHERE ${managedRollout.id} = ${rolloutId}::text
        AND ${managedRollout.state} = 'applying'
    `,
    "objects",
  );
}

async function finishRollout(
  database: Database,
  rolloutId: string,
  finalState: "completed" | "failed" | "aborted",
): Promise<boolean> {
  const guard =
    finalState === "completed"
      ? sql`AND ${managedRollout.currentOrdinal} >= ${managedRollout.stageCount}
          AND NOT EXISTS (
            SELECT 1 FROM ${managedRolloutStage}
            WHERE ${managedRolloutStage.rolloutId} = ${managedRollout.id}
              AND ${managedRolloutStage.state} <> 'confirmed'
          )`
      : finalState === "failed" || finalState === "aborted"
        ? sql`AND NOT EXISTS (
            SELECT 1 FROM ${managedRolloutStage}
            WHERE ${managedRolloutStage.rolloutId} = ${managedRollout.id}
              AND ${managedRolloutStage.recoveryIssuedRevisionSeq} IS NOT NULL
              AND ${managedRolloutStage.recoveryProvenAt} IS NULL
          )`
        : sql``;
  const rows = await executeRows<{ id: string }>(
    database,
    sql`
      UPDATE ${managedRollout}
      SET ${sql.identifier(managedRollout.state.name)} = ${finalState}::text,
          ${sql.identifier(managedRollout.finishedAt.name)} = coalesce(${managedRollout.finishedAt}, now()),
          ${sql.identifier(managedRollout.updatedAt.name)} = now()
      WHERE ${managedRollout.id} = ${rolloutId}::text
        AND ${managedRollout.state} IN ('applying', 'stalled', 'recovering')
        ${guard}
      RETURNING ${managedRollout.id} AS id
    `,
  );
  if (rows[0]) return true;
  const [rollout] = await database
    .select({ state: managedRollout.state })
    .from(managedRollout)
    .where(eq(managedRollout.id, rolloutId));
  return rollout?.state === finalState;
}

async function releaseClaimsIfProven(
  database: Database,
  rolloutId: string,
): Promise<string[]> {
  const snapshot = await readManagedRolloutSnapshot(rolloutId, database);
  if (!snapshot) return [];
  if (!evaluateClaimRelease(snapshot.facts).release) return [];
  const generation = await readTopologyGeneration(database);
  const released = await releaseManagedRolloutClaims(rolloutId, {
    database,
    expectedTopologyGeneration: generation,
  });
  return released.ok ? released.serverIds : [];
}

// --- Link probe issuance and results ---------------------------------------

export type ManagedLinkProbeIssueResult =
  | {
      ok: true;
      request: ManagedLinkProbeRequest;
      notifyServerId: string;
      alreadyIssued?: boolean;
    }
  | {
      ok: false;
      reason:
        | "stage_not_confirmed"
        | "link_mismatch"
        | "destination_stage_missing"
        | "credential_missing"
        | "capability_missing";
    };

async function findDestinationStage(
  database: Database,
  rolloutId: string,
  destinationServerId: string,
  beforeOrdinal: number,
): Promise<ManagedRolloutStage | null> {
  const [stage] = await database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, rolloutId),
        eq(managedRolloutStage.serverId, destinationServerId),
        eq(managedRolloutStage.state, "confirmed"),
        sql`${managedRolloutStage.ordinal} <= ${beforeOrdinal}::integer`,
      ),
    )
    .orderBy(desc(managedRolloutStage.ordinal))
    .limit(1);
  return stage ?? null;
}

async function issueManagedLinkProbe(
  database: Database,
  snapshot: ManagedRolloutSnapshot,
  ordinal: number,
  now: Date,
  force: boolean,
): Promise<ManagedLinkProbeIssueResult> {
  const stage = snapshot.rawStages.find((row) => row.ordinal === ordinal);
  if (!stage || stage.state !== "confirmed" || stage.probeLinkId === null) {
    return { ok: false, reason: "stage_not_confirmed" };
  }
  const [link] = await database
    .select()
    .from(peerLink)
    .where(eq(peerLink.id, stage.probeLinkId));
  if (!link || link.sourceServerId !== stage.serverId) {
    return { ok: false, reason: "link_mismatch" };
  }
  const [inbound] = await database
    .select()
    .from(peerInbound)
    .where(eq(peerInbound.id, link.destinationInboundId));
  if (!inbound) return { ok: false, reason: "link_mismatch" };
  const destinationStage = await findDestinationStage(
    database,
    snapshot.rollout.id,
    inbound.serverId,
    ordinal,
  );
  if (!destinationStage || destinationStage.minRevisionSeq === null) {
    return { ok: false, reason: "destination_stage_missing" };
  }
  const [credential] = await database
    .select({ generation: peerLinkCredential.generation })
    .from(peerLinkCredential)
    .where(
      and(
        eq(peerLinkCredential.linkId, link.id),
        eq(peerLinkCredential.state, "active"),
      ),
    )
    .orderBy(desc(peerLinkCredential.generation))
    .limit(1);
  if (!credential) return { ok: false, reason: "credential_missing" };

  const servers = await database
    .select({
      id: server.id,
      capabilities: server.agentCapabilities,
    })
    .from(server)
    .where(inArray(server.id, [stage.serverId, inbound.serverId]));
  const sourceCapabilities =
    servers.find((row) => row.id === stage.serverId)?.capabilities ?? [];
  const destinationCapabilities =
    servers.find((row) => row.id === inbound.serverId)?.capabilities ?? [];
  if (!supportsLinkProbe(sourceCapabilities, destinationCapabilities)) {
    return { ok: false, reason: "capability_missing" };
  }

  const existing = force
    ? null
    : snapshot.rawStages.length > 0
      ? (
          await database
            .select()
            .from(managedLinkProbe)
            .where(
              and(
                eq(managedLinkProbe.rolloutId, snapshot.rollout.id),
                eq(managedLinkProbe.stageOrdinal, ordinal),
                sql`${managedLinkProbe.outcome} IS NULL`,
                sql`${managedLinkProbe.expiresAt} > ${now.toISOString()}::timestamp`,
              ),
            )
            .orderBy(
              desc(managedLinkProbe.issuedAt),
              desc(managedLinkProbe.createdAt),
              desc(managedLinkProbe.id),
            )
            .limit(1)
        )[0]
      : undefined;
  if (existing) {
    return {
      ok: true,
      request: probeRequestFromRow(existing),
      notifyServerId: stage.serverId,
      alreadyIssued: true,
    };
  }

  const expiresAt = computeStageDeadline(
    now,
    Math.min(
      MANAGED_STAGE_DEADLINE_POLICY.linkProbeSeconds,
      MANAGED_LINK_PROBE_LIMITS.maxTtlMs / 1000,
    ),
  );
  const request: ManagedLinkProbeRequest = {
    probeId: randomUUID(),
    rolloutId: snapshot.rollout.id,
    stageOrdinal: ordinal,
    linkId: link.id,
    credentialGeneration: credential.generation,
    source: {
      serverId: stage.serverId,
      managedFingerprint: stage.managedFingerprint,
      minRevisionSeq: stage.minRevisionSeq ?? 0,
    },
    destination: {
      serverId: inbound.serverId,
      managedFingerprint: destinationStage.managedFingerprint,
      minRevisionSeq: destinationStage.minRevisionSeq,
    },
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await database.insert(managedLinkProbe).values({
    id: request.probeId,
    rolloutId: request.rolloutId,
    stageOrdinal: request.stageOrdinal,
    linkId: request.linkId,
    credentialGeneration: request.credentialGeneration,
    sourceServerId: request.source.serverId,
    destinationServerId: request.destination.serverId,
    sourceMinRevisionSeq: request.source.minRevisionSeq,
    sourceManagedFingerprint: request.source.managedFingerprint,
    destinationMinRevisionSeq: request.destination.minRevisionSeq,
    destinationManagedFingerprint: request.destination.managedFingerprint,
    issuedAt: now,
    expiresAt,
  });
  return {
    ok: true,
    request,
    notifyServerId: stage.serverId,
  };
}

function probeRequestFromRow(
  row: typeof managedLinkProbe.$inferSelect,
): ManagedLinkProbeRequest {
  return {
    probeId: row.id,
    rolloutId: row.rolloutId,
    stageOrdinal: row.stageOrdinal,
    linkId: row.linkId,
    credentialGeneration: row.credentialGeneration,
    source: {
      serverId: row.sourceServerId,
      managedFingerprint: row.sourceManagedFingerprint,
      minRevisionSeq: row.sourceMinRevisionSeq,
    },
    destination: {
      serverId: row.destinationServerId,
      managedFingerprint: row.destinationManagedFingerprint,
      minRevisionSeq: row.destinationMinRevisionSeq,
    },
    issuedAt: (timestampValue(row.issuedAt) ?? new Date(0)).toISOString(),
    expiresAt: (timestampValue(row.expiresAt) ?? new Date(0)).toISOString(),
  };
}

export interface ManagedLinkProbeResultInput {
  /** Comes from the authenticated agent session, never from the payload. */
  authenticatedServerId: string;
  sessionId: string;
  result: ManagedLinkProbeResult;
}

export type ManagedLinkProbeResultDecision =
  | {
      ok: true;
      action: "recorded";
      probeId: string;
      outcome: ManagedLinkProbeOutcome;
      duplicate?: boolean;
    }
  | {
      ok: true;
      action: "rejected";
      reason: string;
    }
  | { ok: false; reason: "activation_disabled" | "session_fenced" };

/**
 * Idempotently records a bounded probe result. Only the source server's current
 * session, the latest probe for the current stage attempt, before expiry, and
 * with success bound to the request's source generation may be recorded.
 */
export async function recordManagedLinkProbeResult(
  input: ManagedLinkProbeResultInput,
  options: ManagedRolloutOptions = {},
): Promise<ManagedLinkProbeResultDecision> {
  const context = resolveContext(options);
  if (!context.activationEnabled) {
    return { ok: false, reason: "activation_disabled" };
  }
  const parsed = managedLinkProbeResultSchema.safeParse(input.result);
  if (!parsed.success) {
    return { ok: true, action: "rejected", reason: "invalid_result" };
  }
  const currentSession = await readCurrentSession(
    context.database,
    input.authenticatedServerId,
  );
  if (!currentSession || currentSession.wsSessionId !== input.sessionId) {
    return { ok: false, reason: "session_fenced" };
  }

  const [probe] = await context.database
    .select()
    .from(managedLinkProbe)
    .where(eq(managedLinkProbe.id, parsed.data.probeId));
  if (!probe) {
    return { ok: true, action: "rejected", reason: "unknown_probe" };
  }
  const [current] = await context.database
    .select({ id: managedLinkProbe.id })
    .from(managedLinkProbe)
    .where(
      and(
        eq(managedLinkProbe.rolloutId, probe.rolloutId),
        eq(managedLinkProbe.stageOrdinal, probe.stageOrdinal),
      ),
    )
    .orderBy(
      desc(managedLinkProbe.issuedAt),
      desc(managedLinkProbe.createdAt),
      desc(managedLinkProbe.id),
    )
    .limit(1);
  const [stage] = await context.database
    .select()
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, probe.rolloutId),
        eq(managedRolloutStage.ordinal, probe.stageOrdinal),
      ),
    );
  const [rollout] = await context.database
    .select()
    .from(managedRollout)
    .where(eq(managedRollout.id, probe.rolloutId));
  if (
    !stage ||
    !rollout ||
    stage.state !== "confirmed" ||
    rollout.currentOrdinal !== stage.ordinal ||
    !["applying", "stalled"].includes(rollout.state)
  ) {
    return { ok: true, action: "rejected", reason: "superseded_probe" };
  }

  const correlation = correlateLinkProbeResult({
    request: probeRequestFromRow(probe),
    currentProbeId: current?.id ?? probe.id,
    authenticatedServerId: input.authenticatedServerId,
    result: parsed.data,
    receivedAt: context.now,
    recordedOutcome: probe.outcome,
  });
  if (correlation.kind === "duplicate") {
    return {
      ok: true,
      action: "recorded",
      probeId: probe.id,
      outcome: parsed.data.outcome,
      duplicate: true,
    };
  }
  if (correlation.kind === "reject") {
    return {
      ok: true,
      action: "rejected",
      reason: correlation.reason,
    };
  }

  const rows = await executeRows<Record<string, unknown>>(
    context.database,
    sql`
      WITH report_session_guard AS (
        SELECT 1 FROM ${server}
        WHERE ${server.id} = ${input.authenticatedServerId}::text
          AND ${server.wsSessionId} = ${input.sessionId}::text
      ),
      recorded AS (
        UPDATE ${managedLinkProbe}
        SET ${sql.identifier(managedLinkProbe.outcome.name)} = ${parsed.data.outcome}::text,
            ${sql.identifier(managedLinkProbe.latencyMs.name)} = ${parsed.data.latencyMs ?? null}::integer,
            ${sql.identifier(managedLinkProbe.appliedDesiredRevisionSeq.name)} = ${parsed.data.applied.desiredRevisionSeq}::integer,
            ${sql.identifier(managedLinkProbe.appliedManagedFingerprint.name)} = ${parsed.data.applied.managedFingerprint}::text,
            ${sql.identifier(managedLinkProbe.completedAt.name)} = ${parsed.data.completedAt}::timestamp,
            ${sql.identifier(managedLinkProbe.recordedAt.name)} = now(),
            ${sql.identifier(managedLinkProbe.updatedAt.name)} = now()
        WHERE ${managedLinkProbe.id} = ${probe.id}::text
          AND ${managedLinkProbe.outcome} IS NULL
          AND ${managedLinkProbe.sourceServerId} = ${input.authenticatedServerId}::text
          AND ${managedLinkProbe.expiresAt} >= ${context.now.toISOString()}::timestamp
          AND EXISTS (SELECT 1 FROM report_session_guard)
        RETURNING ${managedLinkProbe}.*
      )
      SELECT recorded.id AS id, recorded.outcome AS outcome
      FROM recorded
    `,
  );
  if (rows[0]) {
    return {
      ok: true,
      action: "recorded",
      probeId: String(rows[0].id),
      outcome: String(rows[0].outcome) as ManagedLinkProbeOutcome,
    };
  }

  const [currentProbe] = await context.database
    .select()
    .from(managedLinkProbe)
    .where(eq(managedLinkProbe.id, probe.id));
  if (currentProbe?.outcome !== null) {
    return currentProbe?.outcome === parsed.data.outcome
      ? {
          ok: true,
          action: "recorded",
          probeId: probe.id,
          outcome: parsed.data.outcome,
          duplicate: true,
        }
      : { ok: true, action: "rejected", reason: "conflicting_result" };
  }
  const expiresAt = timestampValue(probe.expiresAt);
  if (expiresAt !== null && context.now.getTime() > expiresAt.getTime()) {
    return { ok: true, action: "rejected", reason: "expired" };
  }
  const latestSession = await readCurrentSession(
    context.database,
    input.authenticatedServerId,
  );
  if (!latestSession || latestSession.wsSessionId !== input.sessionId) {
    return { ok: false, reason: "session_fenced" };
  }
  return { ok: true, action: "rejected", reason: "correlation_mismatch" };
}

// --- Reconciliation, retry and abort ----------------------------------------

export type ManagedRolloutReconcileResult =
  | {
      ok: true;
      action: "issued";
      rolloutId: string;
      ordinal: number;
      serverId: string;
      notifyServerId: string;
      revisionSeq: number;
      issuedRevisionSeq: number;
      deadlineAt: Date | null;
    }
  | {
      ok: true;
      action: "await_proof";
      rolloutId: string;
      ordinal: number;
      serverId: string;
      deadlineAt: Date | null;
    }
  | {
      ok: true;
      action: "stalled";
      rolloutId: string;
      ordinal: number;
      serverId: string;
      since: Date;
    }
  | {
      ok: true;
      action: "probe_issued";
      rolloutId: string;
      ordinal: number;
      linkId: string;
      notifyServerId: string;
      request: ManagedLinkProbeRequest;
    }
  | {
      ok: true;
      action: "await_probe";
      rolloutId: string;
      ordinal: number;
      linkId: string;
      probeId: string;
    }
  | {
      ok: true;
      action: "probe_blocked";
      rolloutId: string;
      ordinal: number;
      linkId: string;
      state: "failed" | "expired";
    }
  | {
      ok: true;
      action: "completed";
      rolloutId: string;
      releasedClaimServerIds: string[];
    }
  | {
      ok: true;
      action: "compensated";
      rolloutId: string;
      ordinal: number;
      serverId: string;
      recoveryMinRevisionSeq: number | null;
      recoveryManagedFingerprint: string | null;
      recoveryDeadlineAt: Date | null;
    }
  | {
      ok: true;
      action: "await_recovery";
      rolloutId: string;
      ordinal: number;
      serverId: string;
    }
  | {
      ok: true;
      action: "recovery_finished";
      rolloutId: string;
      finalState: "failed" | "aborted";
      releasedClaimServerIds: string[];
    }
  | {
      ok: true;
      action: "claims_released";
      rolloutId: string;
      releasedClaimServerIds: string[];
    }
  | {
      ok: true;
      action: "paused";
      rolloutId: string;
      serverIds: string[];
    }
  | { ok: true; action: "none"; rolloutId: string }
  | { ok: false; reason: "activation_disabled" | "rollout_not_found" }
  | {
      ok: false;
      reason:
        | "stage_conflict"
        | "topology_conflict"
        | "stage_not_found"
        | "rollout_claim_missing"
        | "invalid_intent"
        | "invalid_previous"
        | "listener_conflict"
        | "probe_stage_not_confirmed"
        | "probe_link_mismatch"
        | "probe_destination_missing"
        | "probe_credential_missing"
        | "probe_capability_missing";
    };

function commitFailureReason(
  result: Exclude<ManagedStageCommitResult, { ok: true }>,
): Extract<ManagedRolloutReconcileResult, { ok: false }>["reason"] {
  switch (result.reason) {
    case "activation_disabled":
      return "activation_disabled";
    case "rollout_not_found":
      return "rollout_not_found";
    case "stage_not_found":
      return "stage_not_found";
    case "topology_conflict":
      return "topology_conflict";
    case "rollout_claim_missing":
      return "rollout_claim_missing";
    case "invalid_intent":
      return "invalid_intent";
    case "invalid_previous":
      return "invalid_previous";
    case "stage_conflict":
      return "stage_conflict";
    default:
      return "listener_conflict";
  }
}

async function commitAtCurrentGeneration(
  database: Database,
  rolloutId: string,
  step: Extract<RolloutStepDecision, { kind: "advance" }>,
): Promise<ManagedStageCommitResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = await readTopologyGeneration(database);
    const result = await commitManagedStage(
      {
        rolloutId,
        expectedOrdinal: step.expectedOrdinal,
        expectedTopologyGeneration: generation,
      },
      { database, activationEnabled: true },
    );
    if (result.ok || result.reason !== "topology_conflict") return result;
  }
  return {
    ok: false,
    reason: "topology_conflict",
    currentGeneration: await readTopologyGeneration(database),
  };
}

async function compensateAtCurrentGeneration(
  database: Database,
  compensation: ManagedStageCompensationRequest,
): Promise<ManagedStageCommitResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = await readTopologyGeneration(database);
    const result = await compensateManagedStage(
      { ...compensation, expectedTopologyGeneration: generation },
      { database, activationEnabled: true },
    );
    if (result.ok || result.reason !== "topology_conflict") return result;
  }
  return {
    ok: false,
    reason: "topology_conflict",
    currentGeneration: await readTopologyGeneration(database),
  };
}

/**
 * One idempotent reconciler step for a heartbeat sweep or bounded maintenance
 * entry point. It issues only the persisted pending stage, marks expiry as
 * stalled without confirming, releases claims only after every proof, and
 * pauses advancement while any claimed server is emergency-disabled.
 */
export async function reconcileManagedRollout(
  rolloutId: string,
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutReconcileResult> {
  const context = resolveContext(options);
  if (!context.activationEnabled) {
    return { ok: false, reason: "activation_disabled" };
  }
  const snapshot = await readManagedRolloutSnapshot(
    rolloutId,
    context.database,
  );
  if (!snapshot) return { ok: false, reason: "rollout_not_found" };

  if (["completed", "failed", "aborted"].includes(snapshot.rollout.state)) {
    const releasedClaimServerIds = await releaseClaimsIfProven(
      context.database,
      rolloutId,
    );
    return {
      ok: true,
      action: releasedClaimServerIds.length > 0 ? "claims_released" : "none",
      rolloutId,
      ...(releasedClaimServerIds.length > 0 ? { releasedClaimServerIds } : {}),
    } as ManagedRolloutReconcileResult;
  }

  if (
    snapshot.pausedServerIds.length > 0 &&
    snapshot.rollout.state !== "recovering"
  ) {
    return {
      ok: true,
      action: "paused",
      rolloutId,
      serverIds: snapshot.pausedServerIds,
    };
  }

  const step = decideRolloutStep(snapshot.facts, context.now);
  switch (step.kind) {
    case "advance": {
      const committed = await commitAtCurrentGeneration(
        context.database,
        rolloutId,
        step,
      );
      if (!committed.ok) {
        return { ok: false, reason: commitFailureReason(committed) };
      }
      return {
        ok: true,
        action: "issued",
        rolloutId,
        ordinal: committed.ordinal,
        serverId: committed.serverId,
        notifyServerId: step.notifyServerId,
        revisionSeq: committed.revisionSeq,
        issuedRevisionSeq: committed.issuedRevisionSeq,
        deadlineAt: committed.deadlineAt,
      };
    }
    case "await_proof":
      return {
        ok: true,
        action: "await_proof",
        rolloutId,
        ordinal: step.ordinal,
        serverId: step.serverId,
        deadlineAt: step.deadlineAt,
      };
    case "stalled":
      await markRolloutStalled(context.database, rolloutId);
      return {
        ok: true,
        action: "stalled",
        rolloutId,
        ordinal: step.ordinal,
        serverId: step.serverId,
        since: step.since,
      };
    case "issue_probe": {
      const issued = await issueManagedLinkProbe(
        context.database,
        snapshot,
        step.ordinal,
        context.now,
        false,
      );
      if (!issued.ok) {
        return {
          ok: false,
          reason:
            issued.reason === "stage_not_confirmed"
              ? "probe_stage_not_confirmed"
              : issued.reason === "link_mismatch"
                ? "probe_link_mismatch"
                : issued.reason === "destination_stage_missing"
                  ? "probe_destination_missing"
                  : issued.reason === "credential_missing"
                    ? "probe_credential_missing"
                    : "probe_capability_missing",
        };
      }
      return {
        ok: true,
        action: "probe_issued",
        rolloutId,
        ordinal: step.ordinal,
        linkId: step.linkId,
        notifyServerId: issued.notifyServerId,
        request: issued.request,
      };
    }
    case "await_probe":
      return {
        ok: true,
        action: "await_probe",
        rolloutId,
        ordinal: step.ordinal,
        linkId: step.linkId,
        probeId: step.probeId,
      };
    case "probe_blocked":
      return {
        ok: true,
        action: "probe_blocked",
        rolloutId,
        ordinal: step.ordinal,
        linkId: step.linkId,
        state: step.state,
      };
    case "complete": {
      const finished = await finishRollout(
        context.database,
        rolloutId,
        "completed",
      );
      if (!finished) {
        return { ok: false, reason: "stage_conflict" };
      }
      const releasedClaimServerIds = await releaseClaimsIfProven(
        context.database,
        rolloutId,
      );
      return {
        ok: true,
        action: "completed",
        rolloutId,
        releasedClaimServerIds,
      };
    }
    case "compensate": {
      const compensated = await compensateAtCurrentGeneration(
        context.database,
        step.compensation,
      );
      if (!compensated.ok) {
        return { ok: false, reason: commitFailureReason(compensated) };
      }
      return {
        ok: true,
        action: "compensated",
        rolloutId,
        ordinal: step.compensation.ordinal,
        serverId: compensated.serverId,
        recoveryMinRevisionSeq: compensated.recoveryMinRevisionSeq ?? null,
        recoveryManagedFingerprint:
          compensated.recoveryManagedFingerprint ?? null,
        recoveryDeadlineAt: compensated.recoveryDeadlineAt ?? null,
      };
    }
    case "await_recovery":
      return {
        ok: true,
        action: "await_recovery",
        rolloutId,
        ordinal: step.ordinal,
        serverId: step.serverId,
      };
    case "finish_recovery": {
      const finished = await finishRollout(
        context.database,
        rolloutId,
        step.finalState,
      );
      if (!finished) {
        return { ok: false, reason: "stage_conflict" };
      }
      const releasedClaimServerIds = await releaseClaimsIfProven(
        context.database,
        rolloutId,
      );
      return {
        ok: true,
        action: "recovery_finished",
        rolloutId,
        finalState: step.finalState,
        releasedClaimServerIds,
      };
    }
    default:
      return { ok: true, action: "none", rolloutId };
  }
}

export type ManagedRolloutRetryResult =
  | {
      ok: true;
      action: "deadline_extended";
      rolloutId: string;
      ordinal: number;
      deadlineAt: Date;
      notifyServerId: string;
    }
  | {
      ok: true;
      action: "probe_issued";
      rolloutId: string;
      ordinal: number;
      linkId: string;
      notifyServerId: string;
      request: ManagedLinkProbeRequest;
    }
  | {
      ok: false;
      reason:
        | "activation_disabled"
        | "rollout_not_found"
        | "not_retryable"
        | "paused"
        | "stage_conflict"
        | "probe_stage_not_confirmed"
        | "probe_link_mismatch"
        | "probe_destination_missing"
        | "probe_credential_missing"
        | "probe_capability_missing";
    };

async function extendStageDeadline(
  database: Database,
  rolloutId: string,
  ordinal: number,
  now: Date,
): Promise<Date | null> {
  const deadlineAt = computeStageDeadline(now);
  const rows = await executeRows<Record<string, unknown>>(
    database,
    sql`
      WITH extended AS (
        UPDATE ${managedRolloutStage}
        SET ${sql.identifier(managedRolloutStage.deadlineAt.name)} = ${deadlineAt.toISOString()}::timestamp,
            ${sql.identifier(managedRolloutStage.updatedAt.name)} = now()
        WHERE ${managedRolloutStage.rolloutId} = ${rolloutId}::text
          AND ${managedRolloutStage.ordinal} = ${ordinal}::integer
          AND ${managedRolloutStage.state} = 'issued'
          AND ${managedRolloutStage.deadlineAt} <= ${now.toISOString()}::timestamp
          AND EXISTS (
            SELECT 1 FROM ${managedRollout}
            WHERE ${managedRollout.id} = ${rolloutId}::text
              AND ${managedRollout.state} = 'stalled'
          )
        RETURNING ${managedRolloutStage}.*
      ),
      resumed AS (
        UPDATE ${managedRollout}
        SET ${sql.identifier(managedRollout.state.name)} = 'applying',
            ${sql.identifier(managedRollout.updatedAt.name)} = now()
        WHERE ${managedRollout.id} = ${rolloutId}::text
          AND ${managedRollout.state} = 'stalled'
          AND EXISTS (SELECT 1 FROM extended)
        RETURNING 1
      )
      SELECT extended.deadline_at AS deadline_at
      FROM extended
      WHERE EXISTS (SELECT 1 FROM resumed)
    `,
  );
  return rows[0] ? timestampValue(rows[0].deadline_at) : null;
}

/**
 * Audited Retry adapter. It never moves the pointer or the sequence: a stalled
 * stage gets a new proof window, a blocked probe gets a new attempt.
 */
export async function retryManagedRolloutStage(
  rolloutId: string,
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutRetryResult> {
  const context = resolveContext(options);
  if (!context.activationEnabled) {
    return { ok: false, reason: "activation_disabled" };
  }
  const snapshot = await readManagedRolloutSnapshot(
    rolloutId,
    context.database,
  );
  if (!snapshot) return { ok: false, reason: "rollout_not_found" };
  if (snapshot.pausedServerIds.length > 0) {
    return { ok: false, reason: "paused" };
  }
  const decision: StageRetryDecision = decideStageRetry(
    snapshot.facts,
    context.now,
  );
  if (decision.kind === "reject") {
    return { ok: false, reason: "not_retryable" };
  }
  if (decision.kind === "extend_deadline") {
    const deadlineAt = await extendStageDeadline(
      context.database,
      rolloutId,
      decision.ordinal,
      context.now,
    );
    if (!deadlineAt) return { ok: false, reason: "not_retryable" };
    return {
      ok: true,
      action: "deadline_extended",
      rolloutId,
      ordinal: decision.ordinal,
      deadlineAt,
      notifyServerId: decision.notifyServerId,
    };
  }
  const issued = await issueManagedLinkProbe(
    context.database,
    snapshot,
    decision.ordinal,
    context.now,
    true,
  );
  if (!issued.ok) {
    return {
      ok: false,
      reason:
        issued.reason === "stage_not_confirmed"
          ? "probe_stage_not_confirmed"
          : issued.reason === "link_mismatch"
            ? "probe_link_mismatch"
            : issued.reason === "destination_stage_missing"
              ? "probe_destination_missing"
              : issued.reason === "credential_missing"
                ? "probe_credential_missing"
                : "probe_capability_missing",
    };
  }
  return {
    ok: true,
    action: "probe_issued",
    rolloutId,
    ordinal: decision.ordinal,
    linkId: decision.linkId,
    notifyServerId: issued.notifyServerId,
    request: issued.request,
  };
}

export type ManagedRolloutAbortResult =
  | {
      ok: true;
      action: "compensated";
      rolloutId: string;
      ordinal: number;
      recoveryMinRevisionSeq: number | null;
      recoveryManagedFingerprint: string | null;
      recoveryDeadlineAt: Date | null;
    }
  | {
      ok: true;
      action: "finished";
      rolloutId: string;
      finalState: "aborted";
      releasedClaimServerIds: string[];
    }
  | {
      ok: false;
      reason:
        | "activation_disabled"
        | "rollout_not_found"
        | "rollout_inactive"
        | "already_recovering"
        | "stage_conflict"
        | "topology_conflict";
    };

/**
 * Audited Abort adapter. An issued candidate is compensated like a failure and
 * stays possibly serving until its recovery target is proven; nothing issued
 * finishes immediately.
 */
export async function abortManagedRollout(
  rolloutId: string,
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutAbortResult> {
  const context = resolveContext(options);
  if (!context.activationEnabled) {
    return { ok: false, reason: "activation_disabled" };
  }
  const snapshot = await readManagedRolloutSnapshot(
    rolloutId,
    context.database,
  );
  if (!snapshot) return { ok: false, reason: "rollout_not_found" };
  const decision: RolloutAbortDecision = decideRolloutAbort(snapshot.facts);
  if (decision.kind === "reject") {
    return {
      ok: false,
      reason:
        decision.reason === "rollout_inactive"
          ? "rollout_inactive"
          : "already_recovering",
    };
  }
  if (decision.kind === "finish_aborted") {
    const finished = await finishRollout(
      context.database,
      rolloutId,
      "aborted",
    );
    if (!finished) return { ok: false, reason: "stage_conflict" };
    const releasedClaimServerIds = await releaseClaimsIfProven(
      context.database,
      rolloutId,
    );
    return {
      ok: true,
      action: "finished",
      rolloutId,
      finalState: "aborted",
      releasedClaimServerIds,
    };
  }
  const compensated = await compensateAtCurrentGeneration(
    context.database,
    decision.compensation,
  );
  if (!compensated.ok) {
    return {
      ok: false,
      reason:
        compensated.reason === "topology_conflict"
          ? "topology_conflict"
          : "stage_conflict",
    };
  }
  return {
    ok: true,
    action: "compensated",
    rolloutId,
    ordinal: decision.compensation.ordinal,
    recoveryMinRevisionSeq: compensated.recoveryMinRevisionSeq ?? null,
    recoveryManagedFingerprint: compensated.recoveryManagedFingerprint ?? null,
    recoveryDeadlineAt: compensated.recoveryDeadlineAt ?? null,
  };
}
