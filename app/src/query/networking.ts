import { MANAGED_NETWORKING_ACTIVATION_ENABLED } from "@blossom/domain/managed-networking";
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { db } from "@/db";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createPeerLinkSchema,
  deleteManagedOutboundSchema,
  deletePeerInboundSchema,
  deletePeerLinkSchema,
  importRuleSetAssetSchema,
  networkingRoutingDraftSchema,
  planNetworkingRolloutSchema,
  rotatePeerLinkCredentialSchema,
  saveManagedOutboundSchema,
  savePeerInboundSchema,
  updatePeerLinkSchema,
  type NetworkingIssue,
} from "@/lib/networking-schema";
import {
  diffRoutingDrafts,
  planManagedRolloutStages,
  type RolloutStagePlan,
} from "@/lib/networking-workspace";
import {
  buildServerIntent,
  nextConfigVersion,
  readNetworkingWorkspace,
  readServerRouting,
  type ServerRoutingView,
} from "@/query/networking-read";
import {
  createPeerLinkDraft,
  deleteManagedOutboundDraft,
  deletePeerInboundDraft,
  deletePeerLinkDraft,
  importRuleSetAssetDraft,
  rotatePeerLinkCredentialDraft,
  saveManagedOutboundDraft,
  savePeerInboundDraft,
  saveRoutingDraft,
  updatePeerLinkDraft,
} from "@/query/networking-write";

/**
 * Admin server functions for Networking (Task 09). Reads use Task 06
 * persistence and Task 08's stable rollout readers; drafts are written through
 * the topology-fenced draft writers. Rollout admission, stage issuance,
 * Retry/Abort, probe delivery and agent notification remain Task 08's surface
 * and are deliberately not duplicated here.
 *
 * Managed activation stays off by default: Apply is refused with
 * `activation_disabled`, while draft CRUD, previews and stage planning work.
 */

export const NETWORKING_QUERY_KEY = ["admin", "networking"] as const;

const routingDraftInput = networkingRoutingDraftSchema;

export const getNetworkingWorkspace = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    return readNetworkingWorkspace(db, MANAGED_NETWORKING_ACTIVATION_ENABLED);
  },
);

export const getServerRouting = createServerFn({ method: "GET" })
  .validator(z.object({ serverId: z.string().min(1) }))
  .handler(async ({ data }) => {
    await ensureAdmin();
    return readServerRouting(
      data.serverId,
      db,
      MANAGED_NETWORKING_ACTIVATION_ENABLED,
    );
  });

export const savePeerInbound = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.peer_inbound_save", {
      targetType: "peer_inbound",
      targetId: fromResult("inboundId"),
    }),
  ])
  .validator(savePeerInboundSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return savePeerInboundDraft(data, db);
  });

export const deletePeerInbound = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.peer_inbound_delete", {
      targetType: "peer_inbound",
      targetId: fromInput("id"),
    }),
  ])
  .validator(deletePeerInboundSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return deletePeerInboundDraft(data.id, data.expectedTopologyGeneration, db);
  });

export const createPeerLink = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.link_create", {
      targetType: "peer_link",
      targetId: fromResult("linkId"),
    }),
  ])
  .validator(createPeerLinkSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return createPeerLinkDraft(data, db);
  });

export const updatePeerLink = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.link_update", {
      targetType: "peer_link",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updatePeerLinkSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return updatePeerLinkDraft(
      data.id,
      data.name,
      data.expectedTopologyGeneration,
      db,
    );
  });

export const rotatePeerLinkCredential = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.link_rotate_credential", {
      targetType: "peer_link",
      targetId: fromInput("id"),
    }),
  ])
  .validator(rotatePeerLinkCredentialSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return rotatePeerLinkCredentialDraft(
      data.id,
      data.expectedTopologyGeneration,
      db,
    );
  });

export const deletePeerLink = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.link_delete", {
      targetType: "peer_link",
      targetId: fromInput("id"),
    }),
  ])
  .validator(deletePeerLinkSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return deletePeerLinkDraft(data.id, data.expectedTopologyGeneration, db);
  });

export const saveManagedOutbound = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.outbound_save", {
      targetType: "managed_outbound",
      targetId: fromResult("outboundId"),
    }),
  ])
  .validator(saveManagedOutboundSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return saveManagedOutboundDraft(data, db);
  });

export const deleteManagedOutbound = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.outbound_delete", {
      targetType: "managed_outbound",
      targetId: fromInput("id"),
    }),
  ])
  .validator(deleteManagedOutboundSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return deleteManagedOutboundDraft(
      data.id,
      data.expectedTopologyGeneration,
      db,
    );
  });

export const importRuleSetPreset = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.rule_set_import", {
      targetType: "managed_rule_set_asset",
      targetId: fromInput("ruleSetId"),
    }),
  ])
  .validator(importRuleSetAssetSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return importRuleSetAssetDraft(data, db);
  });

export interface RoutingDraftSaveResult {
  ok: boolean;
  configVersionId: string | null;
  version: number | null;
  generation: number | null;
  topologyGeneration: number;
  issues: NetworkingIssue[];
  activationEnabled: boolean;
  /** Stable failure code: `validation` or a draft-writer reason. */
  reason: string | null;
}

export const saveRouting = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.routing_save", {
      targetType: "managed_config_version",
      targetId: fromResult("configVersionId"),
    }),
  ])
  .validator(routingDraftInput)
  .handler(async ({ data }): Promise<RoutingDraftSaveResult> => {
    await ensureAdmin();
    const view = await readServerRouting(
      data.serverId,
      db,
      MANAGED_NETWORKING_ACTIVATION_ENABLED,
    );
    const configVersionId = randomUUID();
    const version = await nextConfigVersion(data.serverId, db);
    const built = await buildServerIntent(
      data.serverId,
      {
        configVersionId,
        version,
        topologyGeneration: data.expectedTopologyGeneration,
        rules: data.rules,
        finalOutboundTag: data.finalOutboundTag,
      },
      db,
      MANAGED_NETWORKING_ACTIVATION_ENABLED,
    );
    if (!built.ok || !built.intent || !built.intentDigest) {
      return {
        ok: false,
        configVersionId: null,
        version: null,
        generation: null,
        topologyGeneration: view.topologyGeneration,
        issues: built.issues,
        activationEnabled: MANAGED_NETWORKING_ACTIVATION_ENABLED,
        reason: "validation",
      };
    }
    const written = await saveRoutingDraft(
      {
        configVersionId,
        serverId: data.serverId,
        version,
        intent:
          built.intent as unknown as import("@/orpc/proxy/schema").JsonValue,
        intentDigest: built.intentDigest,
        subscriberNodeIds: built.intent.subscriberInbounds.map(
          (inbound) => inbound.nodeId,
        ),
        expectedTopologyGeneration: data.expectedTopologyGeneration,
      },
      db,
    );
    if (!written.ok) {
      return {
        ok: false,
        configVersionId: null,
        version: null,
        generation: null,
        topologyGeneration:
          written.reason === "topology_conflict"
            ? await currentTopology()
            : view.topologyGeneration,
        issues: built.issues,
        activationEnabled: MANAGED_NETWORKING_ACTIVATION_ENABLED,
        reason: written.reason,
      };
    }
    return {
      ok: true,
      configVersionId: written.configVersionId,
      version: written.version,
      generation: written.generation,
      topologyGeneration: written.generation,
      issues: built.issues,
      activationEnabled: MANAGED_NETWORKING_ACTIVATION_ENABLED,
      reason: null,
    };
  });

async function currentTopology(): Promise<number> {
  const workspace = await readNetworkingWorkspace(
    db,
    MANAGED_NETWORKING_ACTIVATION_ENABLED,
  );
  return workspace.topologyGeneration;
}

export interface PlannedServerView {
  serverId: string;
  serverName: string;
  configVersionId: string;
  version: number;
  topologyGeneration: number;
  intentDigest: string;
  managedFingerprint: string;
  ruleCount: number;
  requiredRuntimeTags: string[];
  removedRuntimeTags: string[];
  peerInboundCount: number;
  outboundCount: number;
  ruleSetCount: number;
  issues: NetworkingIssue[];
  diff: ReturnType<typeof diffRoutingDrafts>;
}

export interface NetworkingRolloutPlanResult {
  ok: boolean;
  activationEnabled: boolean;
  direction: "apply";
  topologyGeneration: number;
  stages: {
    ordinal: number;
    serverId: string;
    serverName: string;
    roles: ("receiver" | "sender" | "routing")[];
    probeLinkIds: string[];
    dependsOnServerIds: string[];
    processImpact: "listener_change" | "route_change" | "routing_change";
    configVersionId: string;
    managedFingerprint: string;
    changedRuleCount: number;
    removedRuntimeTagCount: number;
  }[];
  plan: RolloutStagePlan;
  servers: PlannedServerView[];
  issues: NetworkingIssue[];
  /** Stable failure code: `validation` or `cycle`; null on success. */
  reason: "validation" | "cycle" | null;
}

/**
 * Computes a receiver-first rollout skeleton without claiming servers or
 * writing a rollout. The unsaved draft, when supplied, is only used to plan the
 * named server; every other server uses its latest immutable draft.
 */
export const planNetworkingRollout = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.rollout_plan", {
      targetType: "managed_rollout",
      metadata: fromInput("serverIds"),
    }),
  ])
  .validator(planNetworkingRolloutSchema)
  .handler(async ({ data }): Promise<NetworkingRolloutPlanResult> => {
    await ensureAdmin();
    const workspace = await readNetworkingWorkspace(
      db,
      MANAGED_NETWORKING_ACTIVATION_ENABLED,
    );
    const serverNames = new Map(
      workspace.servers.map((row) => [row.id, row.name]),
    );
    const serverIds = [...new Set(data.serverIds)];
    const built = [];
    for (const serverId of serverIds) {
      const draft =
        data.draft && data.draft.serverId === serverId ? data.draft : null;
      const view = await readServerRouting(
        serverId,
        db,
        MANAGED_NETWORKING_ACTIVATION_ENABLED,
      );
      const rules = draft?.rules ?? view.routing?.rules ?? [];
      const finalOutboundTag =
        draft?.finalOutboundTag ?? view.routing?.finalOutboundTag ?? "direct";
      const version = draft
        ? await nextConfigVersion(serverId, db)
        : (view.routing?.version ?? (await nextConfigVersion(serverId, db)));
      const configVersionId = draft
        ? randomUUID()
        : (view.routing?.configVersionId ?? randomUUID());
      const result = await buildServerIntent(
        serverId,
        {
          configVersionId,
          version,
          topologyGeneration: view.topologyGeneration,
          rules,
          finalOutboundTag,
        },
        db,
        MANAGED_NETWORKING_ACTIVATION_ENABLED,
      );
      built.push({ serverId, view, result, rules, finalOutboundTag });
    }

    const issues = built.flatMap(({ result }) => result.issues);
    const blocking = built.some(({ result }) => !result.ok || !result.intent);
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
    if (blocking || !plan.ok) {
      return {
        ok: false,
        activationEnabled: MANAGED_NETWORKING_ACTIVATION_ENABLED,
        direction: "apply",
        topologyGeneration: workspace.topologyGeneration,
        stages: [],
        plan,
        servers: [],
        issues,
        reason: plan.ok ? "validation" : "cycle",
      };
    }

    const servers = built.map(
      ({ serverId, result, rules, finalOutboundTag }) => {
        const previousRules =
          result.context.previousIntent?.routingPolicy.rules ?? [];
        const previousFinal =
          result.context.previousIntent?.routingPolicy.finalOutboundTag ??
          "direct";
        const diff = diffRoutingDrafts(
          { rules: previousRules, finalOutboundTag: previousFinal },
          { rules, finalOutboundTag },
        );
        return {
          serverId,
          serverName: serverNames.get(serverId) ?? serverId,
          configVersionId: result.intent!.configVersionId,
          version: result.intent!.version,
          topologyGeneration: result.intent!.topologyGeneration,
          intentDigest: result.intentDigest!,
          managedFingerprint: result.managedFingerprint!,
          ruleCount: rules.length,
          requiredRuntimeTags:
            result.intent!.stageExpectations.requiredRuntimeTags,
          removedRuntimeTags:
            result.intent!.stageExpectations.removedRuntimeTags,
          peerInboundCount: result.intent!.peerInbounds.length,
          outboundCount: result.intent!.outbounds.length,
          ruleSetCount: result.intent!.ruleSets.length,
          issues: result.issues,
          diff,
        } satisfies PlannedServerView;
      },
    );
    const serverById = new Map(servers.map((row) => [row.serverId, row]));
    const stages = plan.stages.map((stage) => {
      const row = serverById.get(stage.serverId)!;
      const changedRuleCount =
        row.diff.addedRuleIds.length +
        row.diff.removedRuleIds.length +
        row.diff.changedRuleIds.length;
      return {
        ordinal: stage.ordinal,
        serverId: stage.serverId,
        serverName: row.serverName,
        roles: stage.roles,
        probeLinkIds: stage.probeLinkIds,
        dependsOnServerIds: stage.dependsOnServerIds,
        processImpact: stage.roles.includes("receiver")
          ? ("listener_change" as const)
          : stage.roles.includes("sender")
            ? ("route_change" as const)
            : ("routing_change" as const),
        configVersionId: row.configVersionId,
        managedFingerprint: row.managedFingerprint,
        changedRuleCount,
        removedRuntimeTagCount: row.removedRuntimeTags.length,
      };
    });
    return {
      ok: true,
      activationEnabled: MANAGED_NETWORKING_ACTIVATION_ENABLED,
      direction: "apply",
      topologyGeneration: workspace.topologyGeneration,
      stages,
      plan,
      servers,
      issues,
      reason: null,
    };
  });

export type ServerRoutingData = ServerRoutingView;
export type { RolloutStagePlan };
