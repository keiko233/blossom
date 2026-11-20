/**
 * Client-safe input contracts for the Networking workspace (Task 09). The
 * server functions in `query/networking.ts` validate with the same schemas the
 * editors use, while the persistence rows stay in `db/managed-network-schema.ts`.
 */
import {
  MANAGED_STAGE_INTENT_SCHEMA_VERSION,
  managedIntentRouteRuleSchema,
} from "@blossom/contracts/agent-config-v3";
import { MANAGEABLE_OUTBOUND_IP_FAMILIES } from "@blossom/domain/managed-networking";
import { z } from "zod";

const idSchema = z.string().trim().min(1).max(128);
const nameSchema = z.string().trim().min(1).max(128);
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("://") &&
      !/\s/.test(value) &&
      !value.includes("@"),
    { message: "Use a host name or IP address without a scheme or path" },
  );

export const networkingRuleSchema = managedIntentRouteRuleSchema;
export type NetworkingRuleInput = z.infer<typeof networkingRuleSchema>;

export const networkingRoutingDraftSchema = z
  .object({
    serverId: idSchema,
    finalOutboundTag: z.string().trim().min(1).max(128).default("direct"),
    rules: z.array(networkingRuleSchema).max(2_000),
    /**
     * Topology generation the preview was based on. A newer graph rejects the
     * draft instead of freezing a stale edge set.
     */
    expectedTopologyGeneration: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, rule] of value.rules.entries()) {
      if (seen.has(rule.ruleId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate rule id ${rule.ruleId}`,
          path: ["rules", index, "ruleId"],
        });
      }
      seen.add(rule.ruleId);
    }
  });

export type NetworkingRoutingDraftInput = z.infer<
  typeof networkingRoutingDraftSchema
>;

export const savePeerInboundSchema = z.object({
  id: idSchema.optional(),
  serverId: idSchema,
  expectedTopologyGeneration: z.number().int().min(0),
  name: nameSchema,
  protocol: z.enum(["trojan", "vless"]),
  listenAddress: hostSchema,
  listenPort: z.number().int().min(1).max(65_535),
  advertisedAddress: hostSchema,
  advertisedPort: z.number().int().min(1).max(65_535),
  tlsServerName: hostSchema,
  certificateId: idSchema,
});

export type SavePeerInboundInput = z.infer<typeof savePeerInboundSchema>;

export const deletePeerInboundSchema = z.object({
  id: idSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export const createPeerLinkSchema = z.object({
  sourceServerId: idSchema,
  destinationInboundId: idSchema,
  name: nameSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export type CreatePeerLinkInput = z.infer<typeof createPeerLinkSchema>;

export const updatePeerLinkSchema = z.object({
  id: idSchema,
  name: nameSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export const deletePeerLinkSchema = z.object({
  id: idSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export const rotatePeerLinkCredentialSchema = z.object({
  id: idSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export const saveManagedOutboundSchema = z
  .object({
    id: idSchema.optional(),
    serverId: idSchema,
    expectedTopologyGeneration: z.number().int().min(0),
    name: nameSchema,
    bindInterface: z.string().trim().max(128).optional(),
    ipFamily: z.enum(MANAGEABLE_OUTBOUND_IP_FAMILIES).default("any"),
  })
  .superRefine((value, context) => {
    if (
      value.bindInterface &&
      !/^[A-Za-z0-9_.:-]+$/.test(value.bindInterface)
    ) {
      context.addIssue({
        code: "custom",
        message: "Interface names may only contain letters, digits, _ . : -",
        path: ["bindInterface"],
      });
    }
  });

export type SaveManagedOutboundInput = z.infer<
  typeof saveManagedOutboundSchema
>;

export const deleteManagedOutboundSchema = z.object({
  id: idSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export const importRuleSetAssetSchema = z.object({
  ruleSetId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      "Use lowercase letters, digits, dots, underscores and dashes",
    ),
  version: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid pinned version"),
  source: z.string().trim().min(1).max(512),
  contentBase64: z.string().min(1).max(699_052),
});

export type ImportRuleSetAssetInput = z.infer<typeof importRuleSetAssetSchema>;

export const planNetworkingRolloutSchema = z.object({
  serverIds: z.array(idSchema).min(1).max(50),
  /** Optional unsaved routing draft for one server. */
  draft: networkingRoutingDraftSchema.optional(),
});

export type PlanNetworkingRolloutInput = z.infer<
  typeof planNetworkingRolloutSchema
>;

export const applyNetworkingRolloutSchema = planNetworkingRolloutSchema.extend({
  /** Topology generation the plan was frozen against. */
  expectedTopologyGeneration: z.number().int().min(0),
});

export type ApplyNetworkingRolloutInput = z.infer<
  typeof applyNetworkingRolloutSchema
>;

export const managedStageIntentSchemaVersion =
  MANAGED_STAGE_INTENT_SCHEMA_VERSION;

/** Stable issue codes the editors localize with Paraglide message keys. */
export const NETWORKING_ISSUE_CODES = [
  "activation_disabled",
  "certificate_missing",
  "certificate_material_missing",
  "certificate_generation_missing",
  "credential_missing",
  "duplicate_link",
  "duplicate_rule_id",
  "empty_rule_scope",
  "final_outbound_is_peer",
  "inbound_not_found",
  "link_not_found",
  "no_outbounds",
  "outbound_not_found",
  "peer_inbound_not_found",
  "peer_port_conflict",
  "referenced_resource",
  "rule_set_not_found",
  "server_not_found",
  "stale_topology",
  "topology_conflict",
  "udp_peer_route",
  "unknown_final_outbound",
  "unknown_outbound",
  "unknown_rule_set",
  "unresolved_destination_ip",
  "shadowed_rule",
] as const;

export type NetworkingIssueCode = (typeof NETWORKING_ISSUE_CODES)[number];

export interface NetworkingIssue {
  code: NetworkingIssueCode;
  /** Values interpolated into the localized message, never secrets. */
  params?: Record<string, string | number>;
  /** Rule, link, server or peer-inbound id the issue belongs to. */
  subjectId?: string;
}

export function isNetworkingIssueCode(
  value: string,
): value is NetworkingIssueCode {
  return (NETWORKING_ISSUE_CODES as readonly string[]).includes(value);
}
