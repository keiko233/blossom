/**
 * Client-safe input contracts for the Networking workspace (Task 09). The
 * server functions in `query/networking.ts` validate with the same schemas the
 * editors use, while the persistence rows stay in `db/managed-network-schema.ts`.
 */
import {
  MANAGED_STAGE_INTENT_SCHEMA_VERSION,
  managedIntentRouteRuleSchema,
} from "@blossom/contracts/agent-config-v3";
import {
  MANAGEABLE_OUTBOUND_IP_FAMILIES,
  PEER_PROTOCOLS,
  OUTBOUND_GROUP_PROTOCOLS,
  PEER_NETWORKS,
  isPeerProtocol,
  peerProtocolCapability,
  type PeerProtocol,
} from "@blossom/domain/managed-networking";
import { z } from "zod";

import type { JsonValue } from "@/orpc/proxy/schema";
import {
  isCustomProxyOutboundProtocol,
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  outboundSettingsSchemaFor,
  protocolSupportsTls,
  settingsSchemaFor,
} from "@/orpc/proxy/sing-box-registry";

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

/**
 * Whether a peer inbound protocol needs managed TLS material. Required-TLS
 * protocols always do; optional-TLS protocols (vless/vmess) need it only when
 * the settings fragment enables TLS. Reality supplies its own key exchange, so
 * it is exempt even for a required-TLS protocol.
 */
export function peerInboundTlsRequired(
  protocol: PeerProtocol,
  settings: Record<string, unknown>,
): boolean {
  const capability = peerProtocolCapability(protocol);
  return (
    capability.tlsMode === "required" ||
    (capability.tlsMode === "optional" && isNodeTlsEnabled(settings))
  );
}

/** Strict sing-box schema validation for a peer inbound settings fragment. */
export function validatePeerInboundSettings(
  protocol: string,
  settings: Record<string, JsonValue>,
):
  | { ok: true; settings: Record<string, JsonValue> }
  | { ok: false; message: string } {
  if (!isPeerProtocol(protocol)) {
    return { ok: false, message: `Unsupported peer protocol: ${protocol}` };
  }
  const parsed = settingsSchemaFor(protocol).safeParse(settings);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return {
      ok: false,
      message: `${issue?.message ?? "Invalid settings"}${path}`,
    };
  }
  return {
    ok: true,
    settings: parsed.data as Record<string, JsonValue>,
  };
}

export const savePeerInboundSchema = z
  .object({
    id: idSchema.optional(),
    serverId: idSchema,
    expectedTopologyGeneration: z.number().int().min(0),
    name: nameSchema,
    protocol: z.enum(PEER_PROTOCOLS),
    listenAddress: hostSchema,
    listenPort: z.number().int().min(1).max(65_535),
    advertisedAddress: hostSchema,
    advertisedPort: z.number().int().min(1).max(65_535),
    tlsServerName: hostSchema.nullable().optional(),
    certificateId: idSchema.nullable().optional(),
    network: z.enum(PEER_NETWORKS).default("both"),
    settings: z.record(z.string(), z.json()).default({}),
  })
  .superRefine((value, context) => {
    if (value.certificateId && !protocolSupportsTls(value.protocol)) {
      context.addIssue({
        code: "custom",
        message: `${value.protocol} does not carry a managed TLS certificate`,
        path: ["certificateId"],
      });
    }
    if (
      peerInboundTlsRequired(value.protocol, value.settings) &&
      !isNodeRealityEnabled(value.settings)
    ) {
      if (!value.certificateId) {
        context.addIssue({
          code: "custom",
          message: "TLS is required for this protocol; select a certificate",
          path: ["certificateId"],
        });
      }
      if (!value.tlsServerName) {
        context.addIssue({
          code: "custom",
          message: "TLS is required for this protocol; set a server name",
          path: ["tlsServerName"],
        });
      }
    }
  });

export type SavePeerInboundInput = z.infer<typeof savePeerInboundSchema>;

/**
 * External/third-party sing-box outbound (`custom-out-<id>`). Secret fields are
 * split out and encrypted by the writer; only non-secret settings are stored in
 * the row's `settings` column.
 */
export const saveCustomProxyOutboundSchema = z
  .object({
    id: idSchema.optional(),
    serverId: idSchema,
    expectedTopologyGeneration: z.number().int().min(0),
    name: nameSchema,
    protocol: z.string().trim().min(1).max(64),
    settings: z.record(z.string(), z.json()),
  })
  .superRefine((value, context) => {
    if (!isCustomProxyOutboundProtocol(value.protocol)) {
      context.addIssue({
        code: "custom",
        message: "Select a supported external proxy outbound protocol",
        path: ["protocol"],
      });
      return;
    }
    const parsed = outboundSettingsSchemaFor(value.protocol).safeParse(
      value.settings,
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      context.addIssue({
        code: "custom",
        message: issue?.message ?? "Invalid outbound settings",
        path: ["settings"],
      });
    }
  });

export type SaveCustomProxyOutboundInput = z.infer<
  typeof saveCustomProxyOutboundSchema
>;

/** `selector`/`urltest` outbound group. Member tags are separate from settings. */
export const saveOutboundGroupSchema = z
  .object({
    id: idSchema.optional(),
    serverId: idSchema,
    expectedTopologyGeneration: z.number().int().min(0),
    name: nameSchema,
    protocol: z.enum(OUTBOUND_GROUP_PROTOCOLS),
    memberOutboundTags: z
      .array(z.string().trim().min(1).max(128))
      .min(1)
      .max(128),
    settings: z.record(z.string(), z.json()).default({}),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, tag] of value.memberOutboundTags.entries()) {
      if (seen.has(tag)) {
        context.addIssue({
          code: "custom",
          message: `duplicate group member ${tag}`,
          path: ["memberOutboundTags", index],
        });
      }
      seen.add(tag);
    }
    // The compiler injects `outbounds` from `memberOutboundTags`; never let a
    // draft smuggle a second member list into the free-form settings.
    const parsed = outboundSettingsSchemaFor(value.protocol)
      .omit({ outbounds: true })
      .safeParse(value.settings);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      context.addIssue({
        code: "custom",
        message: issue?.message ?? "Invalid outbound group settings",
        path: ["settings"],
      });
    }
  });

export type SaveOutboundGroupInput = z.infer<typeof saveOutboundGroupSchema>;

/** Automatic peer bridge from a source transit server into a destination exit. */
export const AUTO_BRIDGE_MODES = [
  "auto_create_peer",
  "reuse_peer_inbound",
  "bridge_existing_node",
] as const;
export type AutoBridgeMode = (typeof AUTO_BRIDGE_MODES)[number];

export const autoBridgeSchema = z
  .object({
    sourceServerId: idSchema,
    destinationServerId: idSchema,
    expectedTopologyGeneration: z.number().int().min(0),
    protocol: z.enum(PEER_PROTOCOLS),
    settings: z.record(z.string(), z.json()).optional(),
    network: z.enum(PEER_NETWORKS).optional(),
    mode: z.enum(AUTO_BRIDGE_MODES).default("auto_create_peer"),
    existingPeerInboundId: idSchema.optional(),
    existingNodeId: idSchema.optional(),
    certificateId: idSchema.nullable().optional(),
    tlsServerName: hostSchema.nullable().optional(),
    preferredPort: z.number().int().min(1).max(65_535).optional(),
    /** Also return catch-all routing rules for the source subscriber inbounds. */
    fullForward: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.sourceServerId === value.destinationServerId) {
      context.addIssue({
        code: "custom",
        message: "An auto bridge must target another server",
        path: ["destinationServerId"],
      });
    }
    if (value.mode === "reuse_peer_inbound" && !value.existingPeerInboundId) {
      context.addIssue({
        code: "custom",
        message: "Select the existing peer inbound to reuse",
        path: ["existingPeerInboundId"],
      });
    }
    if (value.mode === "bridge_existing_node" && !value.existingNodeId) {
      context.addIssue({
        code: "custom",
        message: "Select the existing subscriber node to mirror",
        path: ["existingNodeId"],
      });
    }
  });

export type AutoBridgeInput = z.infer<typeof autoBridgeSchema>;

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
