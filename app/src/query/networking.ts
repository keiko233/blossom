import { MANAGED_NETWORKING_ACTIVATION_ENABLED } from "@blossom/domain/managed-networking";
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { db } from "@/db";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  applyNetworkingRolloutSchema,
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
import type { RolloutStagePlan } from "@/lib/networking-workspace";
import {
  buildServerIntent,
  nextConfigVersion,
  readNetworkingWorkspace,
  readServerRouting,
  type ServerRoutingView,
} from "@/query/networking-read";
import {
  applyNetworkingRollout as applyNetworkingRolloutService,
  planNetworkingRollout as planNetworkingRolloutService,
  type NetworkingRolloutApplyResult,
  type NetworkingRolloutPlanResult,
  type PlannedServerView,
} from "@/query/networking-rollout";
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
 * the topology-fenced draft writers. Apply delegates to the server-only
 * admission service, which freezes the previewed stages and hands them to the
 * Task 06/08 atomic writer. Stage issuance, Retry/Abort, probe delivery and
 * agent notification remain the Task 08 surface.
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

/**
 * Computes the frozen receiver-first plan without claiming servers, inserting
 * config versions or writing a rollout. Preview and Apply share this service.
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
    return planNetworkingRolloutService(data);
  });

/**
 * Audited Apply admission. The activation gate is checked inside the service
 * before any write, so the default-off build cannot admit even if a caller
 * bypasses the disabled button. Config versions, stages, server claims and
 * applied-pointer expectations are inserted by one Task 06/08 statement.
 */
export const applyNetworkingRollout = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.rollout_apply", {
      targetType: "managed_rollout",
      targetId: fromResult("rolloutId"),
      metadata: fromInput("serverIds"),
    }),
  ])
  .validator(applyNetworkingRolloutSchema)
  .handler(async ({ data }): Promise<NetworkingRolloutApplyResult> => {
    const session = await ensureAdmin();
    return applyNetworkingRolloutService(data, {
      requestedByUserId: session.user.id,
    });
  });

export type ServerRoutingData = ServerRoutingView;
export type {
  NetworkingRolloutApplyResult,
  NetworkingRolloutPlanResult,
  PlannedServerView,
  RolloutStagePlan,
};
