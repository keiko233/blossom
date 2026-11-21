import {
  managedStageIntentSchema,
  type ManagedStageIntent,
} from "@blossom/contracts/agent-config-v3";
import {
  MANAGED_NETWORKING_ACTIVATION_ENABLED,
  evaluateManagedNetworkingReadiness,
  evaluateManagedSnapshotByteBudget,
  estimateBase64EncodedBytes,
  type ManagedNetworkingReadiness,
  type ManagedSnapshotBudgetEvaluation,
} from "@blossom/domain/managed-networking";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
import { db } from "@/db";
import { managedServerState } from "@/db/managed-network-schema";
import { server } from "@/db/proxy-schema";
import type { PlanNetworkingRolloutInput } from "@/lib/networking-schema";
import type { NetworkingIssue } from "@/lib/networking-schema";
import {
  diffRoutingDrafts,
  planManagedRolloutStages,
  type RolloutStagePlan,
  type RoutingDiff,
} from "@/lib/networking-workspace";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
} from "@/orpc/proxy/singbox";
import {
  admitManagedRollout,
  readTopologyGeneration,
  type ManagedConfigVersionAdmission,
  type ManagedRolloutAdmissionResult,
} from "@/query/managed-topology-write";
import {
  buildServerIntent,
  nextConfigVersion,
  readNetworkingWorkspace,
  readServerRouting,
  type ServerRoutingView,
} from "@/query/networking-read";

/**
 * Server-only Task 09 rollout admission. It freezes the same receiver-first
 * plan the workspace previews, rebuilds every intent from one topology view,
 * then hands the config versions, stages, server claims and applied-pointer
 * expectations to the Task 06/08 atomic admission writer. Preview performs the
 * same checks and writes nothing.
 *
 * The administrator path uses the shared activation setting.
 */

export interface NetworkingRolloutOptions {
  database?: Database;
  /**
   * Test/canary seam. Defaults to the domain switch. The admin
   * server function never passes an override.
   */
  activationEnabled?: boolean;
  requestedByUserId?: string | null;
}

interface Context {
  database: Database;
  activationEnabled: boolean;
  requestedByUserId: string | null;
}

function resolveContext(options: NetworkingRolloutOptions = {}): Context {
  return {
    database: options.database ?? db,
    activationEnabled:
      options.activationEnabled ?? MANAGED_NETWORKING_ACTIVATION_ENABLED,
    requestedByUserId: options.requestedByUserId ?? null,
  };
}

export interface PlannedServerView {
  serverId: string;
  serverName: string;
  /** Immutable version this apply would record. */
  configVersionId: string;
  version: number;
  topologyGeneration: number;
  intentDigest: string;
  managedFingerprint: string;
  previousConfigVersionId: string | null;
  ruleCount: number;
  requiredRuntimeTags: string[];
  removedRuntimeTags: string[];
  peerInboundCount: number;
  outboundCount: number;
  ruleSetCount: number;
  issues: NetworkingIssue[];
  diff: RoutingDiff;
  readiness: ManagedNetworkingReadiness;
  budget: ManagedSnapshotBudgetEvaluation;
}

export interface PlannedStageView {
  ordinal: number;
  serverId: string;
  serverName: string;
  roles: ("receiver" | "sender" | "routing")[];
  probeLinkIds: string[];
  /** The single persisted probe gate for this stage, if any. */
  probeLinkId: string | null;
  dependsOnServerIds: string[];
  processImpact: "listener_change" | "route_change" | "routing_change";
  configVersionId: string;
  intendedVersion: number;
  previousConfigVersionId: string | null;
  managedFingerprint: string;
  changedRuleCount: number;
  removedRuntimeTagCount: number;
}

export interface NetworkingRolloutPlanResult {
  ok: boolean;
  activationEnabled: boolean;
  /**
   * Structural validity plus every readiness and budget gate. The plan remains
   * visible when false so the operator can fix the server or draft.
   */
  admissionReady: boolean;
  direction: "apply";
  topologyGeneration: number;
  stages: PlannedStageView[];
  plan: RolloutStagePlan;
  servers: PlannedServerView[];
  issues: NetworkingIssue[];
  /** Stable failure code: `validation` or `cycle`; null on success. */
  reason: "validation" | "cycle" | null;
}

export type NetworkingRolloutApplyReason =
  | "activation_disabled"
  | "validation"
  | "cycle"
  | "readiness"
  | "budget"
  | "topology_conflict"
  | "claim_conflict"
  | "config_version_conflict"
  | "state_conflict"
  | "rollout_exists"
  | "invalid_admission";

export interface NetworkingRolloutApplyResult {
  ok: boolean;
  reason: NetworkingRolloutApplyReason | null;
  message: string | null;
  activationEnabled: boolean;
  expectedTopologyGeneration: number;
  currentTopologyGeneration: number;
  rolloutId: string | null;
  admissionTopologyGeneration: number | null;
  conflict: {
    serverId?: string;
    rolloutId?: string;
    configVersionId?: string | null;
    version?: number;
    expectedAppliedConfigVersionId?: string | null;
    currentAppliedConfigVersionId?: string | null;
  } | null;
  /** Null only when the gate is off or the expected topology is already stale. */
  plan: NetworkingRolloutPlanResult | null;
  issues: NetworkingIssue[];
}

interface BuiltServer {
  serverId: string;
  serverName: string;
  view: ServerRoutingView;
  rules: ManagedStageIntent["routingPolicy"]["rules"];
  finalOutboundTag: string;
  configVersionId: string;
  version: number;
  previousConfigVersionId: string | null;
  build: Awaited<ReturnType<typeof buildServerIntent>>;
}

interface PreparedServer extends BuiltServer {
  readiness: ManagedNetworkingReadiness;
  budget: ManagedSnapshotBudgetEvaluation;
  diff: RoutingDiff;
}

interface PreparedRollout {
  preparedServers: PreparedServer[];
  plan: RolloutStagePlan;
  result: NetworkingRolloutPlanResult;
}

async function readServerReadiness(
  database: Database,
  serverIds: readonly string[],
): Promise<Map<string, ManagedNetworkingReadiness>> {
  const ids = [...serverIds];
  const [rows, states] = await Promise.all([
    database
      .select({
        id: server.id,
        enabled: server.enabled,
        wsSessionId: server.wsSessionId,
        agentCapabilities: server.agentCapabilities,
        singBoxVersion: server.singBoxVersion,
        runtimeState: server.runtimeState,
        configState: server.configState,
      })
      .from(server)
      .where(inArray(server.id, ids)),
    database
      .select({
        serverId: managedServerState.serverId,
        desiredConfigVersionId: managedServerState.desiredConfigVersionId,
        appliedConfigVersionId: managedServerState.appliedConfigVersionId,
      })
      .from(managedServerState)
      .where(inArray(managedServerState.serverId, ids)),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const stateById = new Map(states.map((row) => [row.serverId, row]));
  return new Map(
    serverIds.map((serverId) => {
      const row = byId.get(serverId);
      const managed = stateById.get(serverId);
      return [
        serverId,
        evaluateManagedNetworkingReadiness({
          enabled: row?.enabled ?? false,
          agentConnected: Boolean(row?.wsSessionId),
          agentCapabilities: row?.agentCapabilities ?? [],
          singBoxVersion: row?.singBoxVersion ?? null,
          runtimeState: row?.runtimeState ?? "unknown",
          configState: row?.configState ?? "unknown",
          desiredConfigVersionId: managed?.desiredConfigVersionId ?? null,
          appliedConfigVersionId: managed?.appliedConfigVersionId ?? null,
        }),
      ];
    }),
  );
}

function intentBudget(
  intent: ManagedStageIntent,
): ManagedSnapshotBudgetEvaluation {
  const ruleSets = intent.ruleSets.map((binding) => ({
    ruleSetId: binding.ruleSetId,
    rawBytes: binding.sizeBytes,
  }));
  const encodedArtifactBytes = ruleSets.reduce(
    (total, binding) => total + estimateBase64EncodedBytes(binding.rawBytes),
    0,
  );
  // Intent JSON plus the base64 overhead of the assets it embeds. Certificate
  // material is not available before compilation, so the live compile still
  // enforces the final 8 MiB wire cap.
  const serializedSnapshotBytes =
    Buffer.byteLength(JSON.stringify(intent), "utf8") + encodedArtifactBytes;
  return evaluateManagedSnapshotByteBudget({
    stage: "activation_preview",
    ruleSets,
    serializedSnapshotBytes,
  });
}

function planProcessImpact(
  roles: readonly ("receiver" | "sender" | "routing")[],
): PlannedStageView["processImpact"] {
  if (roles.includes("receiver")) return "listener_change";
  if (roles.includes("sender")) return "route_change";
  return "routing_change";
}

async function prepareRollout(
  input: PlanNetworkingRolloutInput,
  context: Context,
): Promise<PreparedRollout> {
  const workspace = await readNetworkingWorkspace(
    context.database,
    context.activationEnabled,
  );
  const workspaceServerIds = new Set(workspace.servers.map((row) => row.id));
  const serverIds = [...new Set(input.serverIds)];
  const serverNames = new Map(
    workspace.servers.map((row) => [row.id, row.name]),
  );
  const serverViews = new Map<string, ServerRoutingView>();
  const builtServers: BuiltServer[] = [];
  const issues: NetworkingIssue[] = [];

  for (const serverId of serverIds) {
    if (!workspaceServerIds.has(serverId)) {
      issues.push({ code: "server_not_found", params: { server: serverId } });
      continue;
    }
    const view = await readServerRouting(
      serverId,
      context.database,
      context.activationEnabled,
    );
    serverViews.set(serverId, view);
    const draft =
      input.draft && input.draft.serverId === serverId ? input.draft : null;
    const rules = draft?.rules ?? view.routing?.rules ?? [];
    const finalOutboundTag =
      draft?.finalOutboundTag ?? view.routing?.finalOutboundTag ?? "direct";
    const version = await nextConfigVersion(serverId, context.database);
    const configVersionId = randomUUID();
    const build = await buildServerIntent(
      serverId,
      {
        configVersionId,
        version,
        topologyGeneration: workspace.topologyGeneration,
        rules,
        finalOutboundTag,
      },
      context.database,
      context.activationEnabled,
    );
    builtServers.push({
      serverId,
      serverName: serverNames.get(serverId) ?? serverId,
      view,
      rules,
      finalOutboundTag,
      configVersionId,
      version,
      previousConfigVersionId:
        view.managedState?.appliedConfigVersionId ?? null,
      build,
    });
    issues.push(...build.issues);
  }

  const readiness = await readServerReadiness(
    context.database,
    builtServers.map((row) => row.serverId),
  );
  const preparedServers: PreparedServer[] = builtServers.map((built) => {
    const previousRules =
      built.build.context.previousIntent?.routingPolicy.rules ?? [];
    const previousFinal =
      built.build.context.previousIntent?.routingPolicy.finalOutboundTag ??
      "direct";
    return {
      ...built,
      readiness: readiness.get(built.serverId)!,
      budget: built.build.intent
        ? intentBudget(built.build.intent)
        : evaluateManagedSnapshotByteBudget({
            stage: "activation_preview",
            ruleSets: [],
            serializedSnapshotBytes: 0,
          }),
      diff: diffRoutingDrafts(
        { rules: previousRules, finalOutboundTag: previousFinal },
        { rules: built.rules, finalOutboundTag: built.finalOutboundTag },
      ),
    };
  });

  const blocking = preparedServers.some(
    (prepared) => !prepared.build.ok || !prepared.build.intent,
  );
  const linkPlanInput = workspace.links
    .filter(
      (link) =>
        serverIds.includes(link.sourceServerId) &&
        serverIds.includes(link.destinationServerId),
    )
    .map((link) => ({
      id: link.id,
      sourceServerId: link.sourceServerId,
      destinationServerId: link.destinationServerId,
    }));
  const plan = planManagedRolloutStages({
    serverIds,
    links: linkPlanInput,
    direction: "apply",
  });
  const structuralOk =
    serverIds.length > 0 &&
    !blocking &&
    serverIds.every((serverId) => workspaceServerIds.has(serverId)) &&
    plan.ok;
  const admissionReady =
    structuralOk &&
    preparedServers.every(
      (prepared) => prepared.readiness.ready && prepared.budget.ok,
    );

  const serverById = new Map(
    preparedServers.map((prepared) => [prepared.serverId, prepared]),
  );
  const stages: PlannedStageView[] =
    serverById.size === 0 || !plan.ok
      ? []
      : plan.stages.map((stage) => {
          const prepared = serverById.get(stage.serverId)!;
          const intent = prepared.build.intent!;
          const changedRuleCount =
            prepared.diff.addedRuleIds.length +
            prepared.diff.removedRuleIds.length +
            prepared.diff.changedRuleIds.length;
          return {
            ordinal: stage.ordinal,
            serverId: stage.serverId,
            serverName: prepared.serverName,
            roles: stage.roles,
            probeLinkIds: stage.probeLinkIds,
            probeLinkId: stage.probeLinkIds[0] ?? null,
            dependsOnServerIds: stage.dependsOnServerIds,
            processImpact: planProcessImpact(stage.roles),
            configVersionId: prepared.configVersionId,
            intendedVersion: prepared.version,
            previousConfigVersionId: prepared.previousConfigVersionId,
            managedFingerprint: prepared.build.managedFingerprint!,
            changedRuleCount,
            removedRuntimeTagCount:
              intent.stageExpectations.removedRuntimeTags.length,
          };
        });

  const servers: PlannedServerView[] = preparedServers.map((prepared) => ({
    serverId: prepared.serverId,
    serverName: prepared.serverName,
    configVersionId: prepared.configVersionId,
    version: prepared.version,
    topologyGeneration: prepared.build.intent?.topologyGeneration ?? 0,
    intentDigest: prepared.build.intentDigest ?? "",
    managedFingerprint: prepared.build.managedFingerprint ?? "",
    previousConfigVersionId: prepared.previousConfigVersionId,
    ruleCount: prepared.rules.length,
    requiredRuntimeTags:
      prepared.build.intent?.stageExpectations.requiredRuntimeTags ?? [],
    removedRuntimeTags:
      prepared.build.intent?.stageExpectations.removedRuntimeTags ?? [],
    peerInboundCount: prepared.build.intent?.peerInbounds.length ?? 0,
    outboundCount: prepared.build.intent?.outbounds.length ?? 0,
    ruleSetCount: prepared.build.intent?.ruleSets.length ?? 0,
    issues: prepared.build.issues,
    diff: prepared.diff,
    readiness: prepared.readiness,
    budget: prepared.budget,
  }));

  const reason: NetworkingRolloutPlanResult["reason"] = structuralOk
    ? null
    : plan.ok
      ? "validation"
      : "cycle";
  const result: NetworkingRolloutPlanResult = {
    ok: structuralOk,
    activationEnabled: context.activationEnabled,
    admissionReady,
    direction: "apply",
    topologyGeneration: workspace.topologyGeneration,
    stages: structuralOk ? stages : [],
    plan,
    servers: structuralOk ? servers : [],
    issues,
    reason,
  };
  return { preparedServers, plan, result };
}

/** Computes the frozen plan the workspace previews, without writing anything. */
export async function planNetworkingRollout(
  input: PlanNetworkingRolloutInput,
  options: NetworkingRolloutOptions = {},
): Promise<NetworkingRolloutPlanResult> {
  return (await prepareRollout(input, resolveContext(options))).result;
}

function admissionFailure(
  reason: NetworkingRolloutApplyReason,
  context: Context,
  input: {
    expectedTopologyGeneration: number;
    currentTopologyGeneration: number;
  },
  plan: NetworkingRolloutPlanResult | null,
  extra: Partial<NetworkingRolloutApplyResult> = {},
): NetworkingRolloutApplyResult {
  return {
    ok: false,
    reason,
    message: null,
    activationEnabled: context.activationEnabled,
    expectedTopologyGeneration: input.expectedTopologyGeneration,
    currentTopologyGeneration: input.currentTopologyGeneration,
    rolloutId: null,
    admissionTopologyGeneration: null,
    conflict: null,
    plan,
    issues: plan?.issues ?? [],
    ...extra,
  };
}

function admissionResultFailure(
  result: Exclude<ManagedRolloutAdmissionResult, { ok: true }>,
  context: Context,
  input: {
    expectedTopologyGeneration: number;
    currentTopologyGeneration: number;
  },
  plan: NetworkingRolloutPlanResult,
): NetworkingRolloutApplyResult {
  switch (result.reason) {
    case "activation_disabled":
      return admissionFailure("activation_disabled", context, input, plan);
    case "topology_conflict":
      return admissionFailure(
        "topology_conflict",
        context,
        {
          ...input,
          currentTopologyGeneration: result.currentGeneration,
        },
        plan,
      );
    case "rollout_claim_conflict":
      return admissionFailure("claim_conflict", context, input, plan, {
        conflict: {
          serverId: result.serverId,
          rolloutId: result.rolloutId,
        },
      });
    case "rollout_exists":
      return admissionFailure("rollout_exists", context, input, plan, {
        conflict: { rolloutId: result.rolloutId },
      });
    case "config_version_conflict":
      return admissionFailure("config_version_conflict", context, input, plan, {
        conflict: {
          serverId: result.serverId,
          configVersionId: result.configVersionId,
          version: result.version,
        },
      });
    case "state_conflict":
      return admissionFailure("state_conflict", context, input, plan, {
        conflict: {
          serverId: result.serverId,
          expectedAppliedConfigVersionId: result.expectedAppliedConfigVersionId,
          currentAppliedConfigVersionId: result.currentAppliedConfigVersionId,
        },
      });
    case "invalid_admission":
      return admissionFailure("invalid_admission", context, input, plan, {
        message: result.message,
      });
    default:
      return admissionFailure("invalid_admission", context, input, plan);
  }
}

interface FrozenStageInput {
  ordinal: number;
  serverId: string;
  configVersionId: string;
  managedFingerprint: string;
}

function validateFrozenStageInputs(input: {
  stages: readonly FrozenStageInput[];
  configVersions: readonly ManagedConfigVersionAdmission[];
}): string | null {
  const configById = new Map(
    input.configVersions.map((config) => [config.configVersionId, config]),
  );
  for (const stage of input.stages) {
    const config = configById.get(stage.configVersionId);
    if (!config) {
      return `stage ${stage.ordinal} config version is missing`;
    }
    const parsed = managedStageIntentSchema.safeParse(config.intent);
    if (!parsed.success) {
      return `stage ${stage.ordinal} intent is invalid`;
    }
    if (
      computeManagedStageIntentDigest(parsed.data) !== config.intentDigest ||
      computeManagedStateFingerprint(parsed.data) !== stage.managedFingerprint
    ) {
      return `stage ${stage.ordinal} fingerprint does not match its frozen intent`;
    }
  }
  return null;
}

export interface ApplyNetworkingRolloutInput extends PlanNetworkingRolloutInput {
  expectedTopologyGeneration: number;
}

/**
 * Audited Apply adapter. It only reaches the atomic writer with a complete
 * frozen plan; every conflict leaves the database without config versions,
 * rollout rows or claims because they share one statement.
 */
export async function applyNetworkingRollout(
  input: ApplyNetworkingRolloutInput,
  options: NetworkingRolloutOptions = {},
): Promise<NetworkingRolloutApplyResult> {
  const context = resolveContext(options);
  const expected = input.expectedTopologyGeneration;
  const currentAtStart = await readTopologyGeneration(context.database);
  if (!context.activationEnabled) {
    return admissionFailure(
      "activation_disabled",
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: currentAtStart,
      },
      null,
    );
  }
  if (currentAtStart !== expected) {
    return admissionFailure(
      "topology_conflict",
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: currentAtStart,
      },
      null,
    );
  }

  const prepared = await prepareRollout(input, context);
  const result = prepared.result;
  if (!result.ok) {
    return admissionFailure(
      result.reason ?? "validation",
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: result.topologyGeneration,
      },
      result,
    );
  }
  if (!result.admissionReady) {
    const readinessBlocked = prepared.preparedServers.some(
      (server) => !server.readiness.ready,
    );
    return admissionFailure(
      readinessBlocked ? "readiness" : "budget",
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: result.topologyGeneration,
      },
      result,
    );
  }

  const stages = prepared.plan.stages.map((stage) => {
    const preparedServer = prepared.preparedServers.find(
      (row) => row.serverId === stage.serverId,
    )!;
    return {
      ordinal: stage.ordinal,
      serverId: stage.serverId,
      configVersionId: preparedServer.configVersionId,
      previousConfigVersionId: preparedServer.previousConfigVersionId,
      managedFingerprint: preparedServer.build.managedFingerprint!,
      probeLinkId: stage.probeLinkIds[0] ?? null,
    };
  });
  const configVersions: ManagedConfigVersionAdmission[] =
    prepared.preparedServers.map((preparedServer) => {
      const intent = preparedServer.build.intent!;
      return {
        configVersionId: preparedServer.configVersionId,
        serverId: preparedServer.serverId,
        version: preparedServer.version,
        intent: intent as unknown as JsonValue,
        intentDigest: preparedServer.build.intentDigest!,
        subscriberNodeIds: intent.subscriberInbounds.map(
          (inbound) => inbound.nodeId,
        ),
      };
    });
  const serverIds = prepared.plan.stages.map((stage) => stage.serverId);
  const invalidFrozen = validateFrozenStageInputs({ stages, configVersions });
  if (invalidFrozen) {
    return admissionFailure(
      "invalid_admission",
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: result.topologyGeneration,
      },
      result,
      { message: invalidFrozen },
    );
  }

  // Re-read the exact readiness the atomic statement is about to rely on. The
  // writer separately compare-and-swaps the topology and applied pointers.
  const readiness = await readServerReadiness(context.database, serverIds);
  const staleReadiness = serverIds.find(
    (serverId) => !(readiness.get(serverId)?.ready ?? false),
  );
  if (staleReadiness) {
    return admissionFailure(
      "readiness",
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: result.topologyGeneration,
      },
      {
        ...result,
        servers: result.servers.map((server) => ({
          ...server,
          readiness: readiness.get(server.serverId) ?? server.readiness,
        })),
      },
    );
  }

  const admission = await admitManagedRollout(
    {
      rolloutId: randomUUID(),
      expectedTopologyGeneration: expected,
      stageCount: prepared.plan.stages.length,
      requestedByUserId: context.requestedByUserId,
      serverIds,
      stages,
      configVersions,
      serverStates: prepared.preparedServers.map((preparedServer) => ({
        serverId: preparedServer.serverId,
        appliedConfigVersionId: preparedServer.previousConfigVersionId,
      })),
    },
    {
      database: context.database,
      activationEnabled: true,
    },
  );

  if (!admission.ok) {
    return admissionResultFailure(
      admission,
      context,
      {
        expectedTopologyGeneration: expected,
        currentTopologyGeneration: result.topologyGeneration,
      },
      result,
    );
  }
  return {
    ok: true,
    reason: null,
    message: null,
    activationEnabled: context.activationEnabled,
    expectedTopologyGeneration: expected,
    currentTopologyGeneration: admission.topologyGeneration,
    rolloutId: admission.rolloutId,
    admissionTopologyGeneration: admission.topologyGeneration,
    conflict: null,
    plan: {
      ...result,
      topologyGeneration: result.topologyGeneration,
      admissionReady: true,
    },
    issues: result.issues,
  };
}
