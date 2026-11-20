import type { AgentWsConfigNotifyPayload } from "@blossom/contracts/agent-ws";
import type {
  AgentWsV2ConfigAckPayload,
  AgentWsV2ConfigIdentifier,
} from "@blossom/contracts/agent-ws-v2";
import type {
  ManagedLinkProbeRequest,
  ManagedLinkProbeResult,
} from "@blossom/contracts/managed-link-probe";
import { MANAGED_LINK_PROBE_CAPABILITY } from "@blossom/contracts/managed-link-probe";
import { MANAGED_NETWORKING_ACTIVATION_ENABLED } from "@blossom/domain/managed-networking";
import { and, eq } from "drizzle-orm";

import { type Database, db } from "@/db";
import { managedRolloutStage } from "@/db/managed-network-schema";
import { server } from "@/db/proxy-schema";
import { buildAgentDesiredState } from "@/orpc/proxy/agent-desired-state";
import { invalidateDesiredConfigRevisions } from "@/query/agent";
import {
  abortManagedRollout,
  findActiveManagedRolloutId,
  listActiveManagedRolloutIds,
  reconcileManagedRollout,
  recordManagedLinkProbeResult,
  recordManagedStageReport,
  retryManagedRolloutStage,
  type ManagedRolloutAbortResult,
  type ManagedRolloutOptions,
  type ManagedRolloutReconcileResult,
  type ManagedRolloutRetryResult,
  type ManagedStageReportResult,
} from "@/query/managed-rollout-write";

/**
 * Task 08 transport/control-plane integration.
 *
 * The v2 session forwards authenticated reports here. This module resolves the
 * issued identifier's managed fingerprint, records the stage outcome through
 * the Task 06/08 database adapter, and asks the persisted reconciler for the
 * next idempotent step. It never keeps rollout state in memory and never
 * treats a timeout as proof.
 *
 * Several steps have to be carried out after the database commit and may not
 * reach an agent (socket replaced, Durable Object unavailable, Redis lost).
 * They are returned as follow-ups so the hub, the Cloudflare Durable Object or
 * the maintenance route can deliver them with its own notification path. The
 * next `agent.status` exchange is the correctness fallback for a missed push.
 */

export type ManagedRolloutFollowUp =
  | {
      kind: "config_notify";
      serverId: string;
      payload: AgentWsConfigNotifyPayload;
    }
  | {
      kind: "link_probe";
      serverId: string;
      sessionId: string;
      request: ManagedLinkProbeRequest;
    };

export interface ManagedRolloutDispatchPort {
  notifyConfigChanged(
    serverId: string,
    payload: AgentWsConfigNotifyPayload,
  ): Promise<void>;
  sendLinkProbe(
    serverId: string,
    sessionId: string,
    request: ManagedLinkProbeRequest,
  ): Promise<boolean>;
}

export interface ManagedRolloutDispatchResult {
  notifiedServerIds: string[];
  probeIds: string[];
}

interface RuntimeContext {
  database: Database;
  activationEnabled: boolean;
  now: Date;
}

function resolveContext(options: ManagedRolloutOptions = {}): RuntimeContext {
  return {
    database: options.database ?? db,
    activationEnabled:
      options.activationEnabled ?? MANAGED_NETWORKING_ACTIVATION_ENABLED,
    now: options.now ?? new Date(),
  };
}

function logFailure(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`managed rollout ${operation} failed: ${message}`);
}

async function currentServerSession(
  database: Database,
  serverId: string,
): Promise<{
  id: string;
  enabled: boolean;
  appliedRevisionSeq: number;
  assignedRevisionSeq: number;
  wsSessionId: string | null;
  agentCapabilities: string[];
} | null> {
  const [row] = await database
    .select({
      id: server.id,
      enabled: server.enabled,
      appliedRevisionSeq: server.appliedRevisionSeq,
      assignedRevisionSeq: server.desiredRevisionSeq,
      wsSessionId: server.wsSessionId,
      agentCapabilities: server.agentCapabilities,
    })
    .from(server)
    .where(eq(server.id, serverId));
  return row ?? null;
}

/**
 * Builds the best-effort post-commit `config.notify`. The desired revision is
 * compiled with the v2 managed delivery and the agent's recorded capability;
 * an unsupported or inconsistent managed state skips the push, and the next
 * status exchange still recompiles because the stage advance moved the
 * server's sequence.
 */
async function configNotifyFollowUp(
  serverId: string,
  reason: string,
  context: RuntimeContext,
): Promise<ManagedRolloutFollowUp | null> {
  try {
    const row = await currentServerSession(context.database, serverId);
    if (!row) return null;
    const desired = await buildAgentDesiredState(
      {
        id: row.id,
        enabled: row.enabled,
        desiredRevisionSeq: row.assignedRevisionSeq,
      },
      {
        database: context.database,
        managedDelivery: "v2",
        agentCapabilities: row.agentCapabilities,
        advanceCertificates: false,
      },
    );
    await invalidateDesiredConfigRevisions([serverId], context.database);
    return {
      kind: "config_notify",
      serverId,
      payload: {
        desiredRevisionSeq: desired.desiredRevisionSeq,
        desiredRevision: desired.desiredRevision,
        reason,
      },
    };
  } catch (error) {
    logFailure(`config notify for ${serverId}`, error);
    return null;
  }
}

/**
 * Sends a probe only to the source server's exact current socket, before the
 * request expires, and only while both the recorded capability and session
 * fence still hold. A missing socket leaves the probe to expire; the audited
 * Retry issues a new attempt.
 */
async function linkProbeFollowUp(
  request: ManagedLinkProbeRequest,
  context: RuntimeContext,
): Promise<ManagedRolloutFollowUp | null> {
  if (Date.parse(request.expiresAt) <= context.now.getTime()) {
    return null;
  }
  const row = await currentServerSession(
    context.database,
    request.source.serverId,
  );
  if (
    !row ||
    !row.enabled ||
    !row.wsSessionId ||
    !row.agentCapabilities.includes(MANAGED_LINK_PROBE_CAPABILITY)
  ) {
    return null;
  }
  return {
    kind: "link_probe",
    serverId: row.id,
    sessionId: row.wsSessionId,
    request,
  };
}

async function followUpsForReconcile(
  result: ManagedRolloutReconcileResult,
  context: RuntimeContext,
): Promise<ManagedRolloutFollowUp[]> {
  if (!result.ok) return [];
  switch (result.action) {
    case "issued":
      return compact([
        await configNotifyFollowUp(
          result.notifyServerId,
          "managed rollout stage issued",
          context,
        ),
      ]);
    case "compensated":
      return compact([
        await configNotifyFollowUp(
          result.serverId,
          "managed rollout recovery issued",
          context,
        ),
      ]);
    case "probe_issued":
      return compact([await linkProbeFollowUp(result.request, context)]);
    default:
      return [];
  }
}

function compact(
  values: readonly (ManagedRolloutFollowUp | null)[],
): ManagedRolloutFollowUp[] {
  return values.filter((value): value is ManagedRolloutFollowUp =>
    Boolean(value),
  );
}

/** One idempotent reconciler step for a server's active rollout, if any. */
export async function reconcileManagedRolloutForServer(
  serverId: string,
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutFollowUp[]> {
  const context = resolveContext(options);
  if (!context.activationEnabled) return [];
  const rolloutId = await findActiveManagedRolloutId(
    serverId,
    context.database,
  );
  if (!rolloutId) return [];
  const result = await reconcileManagedRollout(rolloutId, {
    database: context.database,
    activationEnabled: true,
    now: context.now,
  });
  if (!result.ok) {
    if (result.reason !== "activation_disabled") {
      logFailure(`reconcile ${rolloutId}`, new Error(result.reason));
    }
    return [];
  }
  return followUpsForReconcile(result, context);
}

/**
 * Authenticated `config.ack` ingress. Only the database adapter may confirm or
 * compensate; the transport supplies the exact session and the acknowledged
 * identifier, while the adapter resolves the issued fingerprint evidence.
 */
export async function applyManagedConfigAck(
  event: {
    serverId: string;
    sessionId: string;
    ack: AgentWsV2ConfigAckPayload;
    outcome: "applied" | "failed";
  },
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutFollowUp[]> {
  const context = resolveContext(options);
  if (!context.activationEnabled) return [];
  const result: ManagedStageReportResult = await recordManagedStageReport(
    {
      authenticatedServerId: event.serverId,
      sessionId: event.sessionId,
      outcome: event.outcome,
      desiredRevisionSeq: event.ack.desired.desiredRevisionSeq,
    },
    { database: context.database, activationEnabled: true },
  );
  const followUps: ManagedRolloutFollowUp[] = [];
  if (result.ok && result.action === "compensated") {
    const notify = await configNotifyFollowUp(
      event.serverId,
      "managed rollout recovery issued",
      context,
    );
    if (notify) followUps.push(notify);
  }
  followUps.push(
    ...(await reconcileManagedRolloutForServer(event.serverId, {
      database: context.database,
      activationEnabled: true,
      now: context.now,
    })),
  );
  return followUps;
}

/**
 * `hello` proof. A reconnecting agent reports the identifier it last committed,
 * so a stage that was issued before the reconnect can be confirmed without a
 * fresh snapshot. The adapter resolves the issued managed fingerprint.
 */
export async function applyManagedHello(
  event: {
    serverId: string;
    sessionId: string;
    applied: AgentWsV2ConfigIdentifier | null;
  },
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutFollowUp[]> {
  const context = resolveContext(options);
  if (!context.activationEnabled) return [];
  if (event.applied) {
    await recordManagedStageReport(
      {
        authenticatedServerId: event.serverId,
        sessionId: event.sessionId,
        outcome: "applied",
        desiredRevisionSeq: event.applied.desiredRevisionSeq,
      },
      { database: context.database, activationEnabled: true },
    );
  }
  return reconcileManagedRolloutForServer(event.serverId, {
    database: context.database,
    activationEnabled: true,
    now: context.now,
  });
}

/**
 * `agent.status` is the replayable heartbeat. It proves the identifier already
 * recorded by this server's last applied report, which recovers a stage report
 * lost after the durable ack, then reconciles deadlines even when the
 * notification was missed.
 */
export async function applyManagedStatus(
  event: { serverId: string; sessionId: string },
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutFollowUp[]> {
  const context = resolveContext(options);
  if (!context.activationEnabled) return [];
  const row = await currentServerSession(context.database, event.serverId);
  if (!row || row.wsSessionId !== event.sessionId) return [];
  if (row.appliedRevisionSeq > 0) {
    await recordManagedStageReport(
      {
        authenticatedServerId: event.serverId,
        sessionId: event.sessionId,
        outcome: "applied",
        desiredRevisionSeq: row.appliedRevisionSeq,
      },
      { database: context.database, activationEnabled: true },
    );
  }
  return reconcileManagedRolloutForServer(event.serverId, {
    database: context.database,
    activationEnabled: true,
    now: context.now,
  });
}

/**
 * `link_probe.result` ingress. Results are idempotent per probe and accepted
 * only for the source server's current session; this call never confirms a
 * stage itself. A successful result lets the reconciler advance, and a
 * failure/expiry leaves the stage blocked until an audited Retry.
 */
export async function applyManagedProbeResult(
  event: {
    serverId: string;
    sessionId: string;
    result: ManagedLinkProbeResult;
  },
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutFollowUp[]> {
  const context = resolveContext(options);
  if (!context.activationEnabled) return [];
  const decision = await recordManagedLinkProbeResult(
    {
      authenticatedServerId: event.serverId,
      sessionId: event.sessionId,
      result: event.result,
    },
    { database: context.database, activationEnabled: true, now: context.now },
  );
  if (!decision.ok || decision.action !== "recorded") {
    return [];
  }
  return reconcileManagedRolloutForServer(event.serverId, {
    database: context.database,
    activationEnabled: true,
    now: context.now,
  });
}

/**
 * Authenticated maintenance sweep. The caller supplies only a bounded count;
 * the persisted rollout state determines every action. One failing rollout is
 * logged and the rest of the batch continues.
 */
export async function sweepManagedRollouts(
  input: { limit?: number } & ManagedRolloutOptions = {},
): Promise<{
  activationDisabled: boolean;
  scanned: number;
  followUps: ManagedRolloutFollowUp[];
  errors: number;
}> {
  const context = resolveContext(input);
  if (!context.activationEnabled) {
    return {
      activationDisabled: true,
      scanned: 0,
      followUps: [],
      errors: 0,
    };
  }
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const rolloutIds = await listActiveManagedRolloutIds(limit, context.database);
  const followUps: ManagedRolloutFollowUp[] = [];
  let errors = 0;
  for (const rolloutId of rolloutIds) {
    try {
      const result = await reconcileManagedRollout(rolloutId, {
        database: context.database,
        activationEnabled: true,
        now: context.now,
      });
      if (!result.ok) {
        errors += 1;
        if (result.reason !== "activation_disabled") {
          logFailure(`sweep ${rolloutId}`, new Error(result.reason));
        }
        continue;
      }
      followUps.push(...(await followUpsForReconcile(result, context)));
    } catch (error) {
      errors += 1;
      logFailure(`sweep ${rolloutId}`, error);
    }
  }
  return {
    activationDisabled: false,
    scanned: rolloutIds.length,
    followUps,
    errors,
  };
}

export interface ManagedRolloutRetryOutcome {
  result: ManagedRolloutRetryResult;
  followUps: ManagedRolloutFollowUp[];
}

/** Audited Retry adapter: the caller records the admin audit and delivers these. */
export async function retryManagedRolloutAndNotify(
  rolloutId: string,
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutRetryOutcome> {
  const context = resolveContext(options);
  const result = await retryManagedRolloutStage(rolloutId, {
    database: context.database,
    activationEnabled: context.activationEnabled,
    now: context.now,
  });
  if (!result.ok) return { result, followUps: [] };
  if (result.action === "deadline_extended") {
    return {
      result,
      followUps: compact([
        await configNotifyFollowUp(
          result.notifyServerId,
          "managed rollout retry",
          context,
        ),
      ]),
    };
  }
  return {
    result,
    followUps: compact([await linkProbeFollowUp(result.request, context)]),
  };
}

export interface ManagedRolloutAbortOutcome {
  result: ManagedRolloutAbortResult;
  followUps: ManagedRolloutFollowUp[];
}

/** Audited Abort adapter: recovery notification is post-commit and optional. */
export async function abortManagedRolloutAndNotify(
  rolloutId: string,
  options: ManagedRolloutOptions = {},
): Promise<ManagedRolloutAbortOutcome> {
  const context = resolveContext(options);
  const result = await abortManagedRollout(rolloutId, {
    database: context.database,
    activationEnabled: context.activationEnabled,
    now: context.now,
  });
  if (!result.ok || result.action !== "compensated") {
    return { result, followUps: [] };
  }
  // The compensation is for the current ordinal; its server is the only one
  // that receives a recovery push.
  const serverId = await stageServerIdForOrdinal(
    context.database,
    rolloutId,
    result.ordinal,
  );
  if (!serverId) return { result, followUps: [] };
  return {
    result,
    followUps: compact([
      await configNotifyFollowUp(
        serverId,
        "managed rollout recovery issued",
        context,
      ),
    ]),
  };
}

/**
 * Finds the stage's server for a compensation follow-up. The row is already
 * persisted; no decisions are made here.
 */
async function stageServerIdForOrdinal(
  database: Database,
  rolloutId: string,
  ordinal: number,
): Promise<string | null> {
  const [row] = await database
    .select({ serverId: managedRolloutStage.serverId })
    .from(managedRolloutStage)
    .where(
      and(
        eq(managedRolloutStage.rolloutId, rolloutId),
        eq(managedRolloutStage.ordinal, ordinal),
      ),
    );
  return row?.serverId ?? null;
}

function dedupeConfigNotify(
  followUps: readonly ManagedRolloutFollowUp[],
): ManagedRolloutFollowUp[] {
  const byServer = new Map<string, ManagedRolloutFollowUp>();
  const probes: ManagedRolloutFollowUp[] = [];
  for (const followUp of followUps) {
    if (followUp.kind === "config_notify") {
      byServer.set(followUp.serverId, followUp);
    } else {
      probes.push(followUp);
    }
  }
  return [...byServer.values(), ...probes];
}

/**
 * Delivers post-commit follow-ups through whichever transport owns the target.
 * Every failure is best effort: the agent's next status exchange recovers a
 * lost notification, and a missing probe expires into the stalled surface.
 */
export async function dispatchManagedRolloutFollowUps(
  followUps: readonly ManagedRolloutFollowUp[],
  port: ManagedRolloutDispatchPort,
): Promise<ManagedRolloutDispatchResult> {
  const notifiedServerIds: string[] = [];
  const probeIds: string[] = [];
  for (const followUp of dedupeConfigNotify(followUps)) {
    try {
      if (followUp.kind === "config_notify") {
        await port.notifyConfigChanged(followUp.serverId, followUp.payload);
        notifiedServerIds.push(followUp.serverId);
        continue;
      }
      if (
        await port.sendLinkProbe(
          followUp.serverId,
          followUp.sessionId,
          followUp.request,
        )
      ) {
        probeIds.push(followUp.request.probeId);
      }
    } catch (error) {
      logFailure(`follow-up ${followUp.kind}`, error);
    }
  }
  return { notifiedServerIds, probeIds };
}
