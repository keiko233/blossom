import {
  agentConfigV3OutputSchema,
  type AgentConfigV3Output,
  certificateArtifactSchema,
  type CertificateArtifact,
  formatManagedPeerTlsBindingId,
  MANAGED_NETWORKING_V2_CAPABILITY,
  MANAGED_PEER_TLS_DIRECTIONS,
  MANAGED_PEER_TLS_OWNER_KINDS,
  MANAGED_PEER_TLS_USAGES,
  MANAGED_RULE_SET_FORMATS,
  MANAGED_SNAPSHOT_LIMITS,
  MANAGED_SNAPSHOT_SCHEMA_VERSION,
  MANAGED_STAGE_INTENT_SCHEMA_VERSION,
  managedIntentOutboundSchema,
  type ManagedIntentOutbound,
  managedIntentPeerAdmissionSchema,
  type ManagedIntentPeerAdmission,
  managedIntentPeerInboundSchema,
  type ManagedIntentPeerInbound,
  managedIntentPeerTrustRefSchema,
  type ManagedIntentPeerTrustRef,
  managedIntentRouteRuleSchema,
  type ManagedIntentRouteRule,
  managedIntentSubscriberInboundSchema,
  type ManagedIntentSubscriberInbound,
  managedPeerCertificateDeploymentSchema,
  type ManagedPeerCertificateDeployment,
  managedPeerTlsBindingSchema,
  type ManagedPeerTlsBinding,
  type ManagedPeerTlsDirection,
  type ManagedPeerTlsOwnerKind,
  type ManagedPeerTlsUsage,
  managedPeerTrustArtifactSchema,
  type ManagedPeerTrustArtifact,
  managedRuleSetArtifactSchema,
  type ManagedRuleSetArtifact,
  managedRuleSetBindingSchema,
  type ManagedRuleSetBinding,
  type ManagedRuleSetFormat,
  managedSnapshotExtensionSchema,
  type ManagedSnapshotExtension,
  managedStageExpectationsSchema,
  type ManagedStageExpectations,
  managedStageIntentSchema,
  type ManagedStageIntent,
  managedTlsBindingSchema,
  type ManagedTlsBinding,
} from "@blossom/contracts/agent-config-v3";
import { z } from "zod";

import {
  CERTIFICATE_CHALLENGE_TYPES,
  managedCertificateInsertSchema,
} from "@/db/proxy-schema";

import {
  isNodeProtocol,
  NODE_PROTOCOLS,
  settingsSchemaFor,
} from "./sing-box-registry";

export { NODE_PROTOCOLS };
export type { NodeProtocol } from "./sing-box-registry";

/**
 * Server input schemas. A server is one physical host: name/remark/address/
 * enabled + the manageable agent credentials (write-only on create/reset; the
 * plaintext is returned exactly once). Specified separately from nodes so the
 * admin UI can manage servers and their tokens independently of the inbounds
 * the host runs.
 */

/** Serializable JSON value — used for jsonb columns that cross the server-fn boundary. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const serverMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  enabled: z.boolean().default(true),
  address: z.string().min(1),
  desiredAgentVersion: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(
      (value) => value === "latest" || /^v?\d+\.\d+\.\d+([-.].+)?$/.test(value),
      { message: "Use latest or a semantic version such as 0.3.0" },
    )
    .nullable()
    .optional(),
  desiredSingBoxVersion: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(
      (value) => value === "latest" || /^v?\d+\.\d+\.\d+([-.].+)?$/.test(value),
      { message: "Use latest or a version such as 1.14.4" },
    )
    .nullable()
    .optional(),
  configPollIntervalSeconds: z.number().int().min(5).max(86_400).default(60),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300).default(30),
});

export const createServerSchema = serverMetaSchema.extend({
  /**
   * Standalone callers that omit this field keep the existing static-token
   * default. The create form sends `false` explicitly so the UI is OAuth-first
   * without changing the API's rollout behavior.
   */
  enableBackupToken: z.boolean().default(true),
});

export const updateServerSchema = serverMetaSchema.partial().extend({
  id: z.string().min(1),
});

export const serverIdSchema = z.object({ id: z.string().min(1) });

export type CreateServerInput = z.infer<typeof createServerSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

/**
 * Node input schemas. Protocol-specific configuration lives in `settings`, a native
 * sing-box inbound fragment validated against the schema for the chosen `protocol`
 * (see `sing-box-registry`). There is no hand-written per-protocol shape — the
 * sing-box schema is the single source of truth.
 */

const protocolSchema = z
  .string()
  .refine(isNodeProtocol, { message: "Unsupported protocol" });

// The stored settings fragment. Validated loosely here (it's protocol-dependent) and
// then strictly re-validated against `settingsSchemaFor(protocol)` in `parseNodeInput`.
const settingsSchema = z.record(z.string(), z.json());

const serverRefSchema = z.string().min(1);

const nodeMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  serverId: serverRefSchema,
  // Optional override; null/undefined means "use server.address".
  address: z.string().min(1).nullable().optional(),
  listenPort: z.number().int().min(1).max(65535),
  protocol: protocolSchema,
  certificateId: z.string().min(1).nullable().optional(),
  tlsServerName: z.string().min(1).nullable().optional(),
  settings: settingsSchema,
});

export const createNodeSchema = nodeMetaSchema;

export const updateNodeSchema = nodeMetaSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;

/**
 * Strictly validates `settings` against the sing-box schema for `protocol`, returning
 * the parsed (schema-normalized) fragment. Call this in the server functions after the
 * coarse zod validation above.
 */
export function parseNodeSettings(
  protocol: string,
  settings: unknown,
): Record<string, JsonValue> {
  if (!isNodeProtocol(protocol)) {
    throw new Error(`Unsupported protocol: ${protocol}`);
  }
  return settingsSchemaFor(protocol).parse(settings) as Record<
    string,
    JsonValue
  >;
}

export const nodeIdSchema = z.object({ id: z.string().min(1) });

// --- Groups ------------------------------------------------------------------

const groupMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  sortOrder: z.number().int().default(0),
  // Full membership list; create/update replace the node_group rows with it.
  nodeIds: z.array(z.string().min(1)).default([]),
});

export const createGroupSchema = groupMetaSchema;

export const updateGroupSchema = groupMetaSchema.partial().extend({
  id: z.string().min(1),
  /**
   * Omitting the list updates metadata and the revision only. Declared again
   * after `partial()` so the create schema's `.default([])` cannot turn an
   * omitted list into a membership clear.
   */
  nodeIds: z.array(z.string().min(1)).optional(),
  /**
   * Optional optimistic-concurrency token (`proxy_group.revision`).
   * Ordered group editor writes supply this so concurrent edits fail with a
   * revision conflict; legacy compatibility callers may omit it.
   */
  expectedRevision: z.number().int().min(1).optional(),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const groupIdSchema = z.object({ id: z.string().min(1) });

export const deleteGroupSchema = groupIdSchema.extend({
  expectedRevision: z.number().int().min(1).optional(),
});

// --- Managed certificates ---------------------------------------------------

const certificatePolicyBaseSchema = managedCertificateInsertSchema
  .pick({
    name: true,
    kind: true,
    domains: true,
    acmeEmail: true,
    acmeProvider: true,
    acmeStaging: true,
    selfSignedValidityDays: true,
    renewalDaysBeforeExpiry: true,
  })
  .extend({
    issuerServerId: z.string().min(1).optional(),
    challengeType: z.enum(CERTIFICATE_CHALLENGE_TYPES).default("dns-01"),
  });

export const createCertificateSchema = certificatePolicyBaseSchema;
export const updateCertificateSchema = certificatePolicyBaseSchema
  .partial()
  .extend({
    id: z.string().min(1),
  });
export const certificateIdSchema = z.object({ id: z.string().min(1) });

export const createImportedCertificateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  fullchainPem: z
    .string()
    .min(1)
    .max(1024 * 1024),
  privateKeyPem: z
    .string()
    .min(1)
    .max(256 * 1024),
});

export const replaceImportedCertificateMaterialSchema = z.object({
  certificateId: z.string().min(1),
  fullchainPem: z
    .string()
    .min(1)
    .max(1024 * 1024),
  privateKeyPem: z
    .string()
    .min(1)
    .max(256 * 1024),
});

export const certificateMaterialActionSchema = z.object({
  certificateId: z.string().min(1),
});

export type CreateCertificateInput = z.infer<typeof createCertificateSchema>;
export type UpdateCertificateInput = z.infer<typeof updateCertificateSchema>;
export type CreateImportedCertificateInput = z.infer<
  typeof createImportedCertificateSchema
>;
export type ReplaceImportedCertificateMaterialInput = z.infer<
  typeof replaceImportedCertificateMaterialSchema
>;

// --- Agent -----------------------------------------------------------------

/**
 * One certificate a server-agent has material for. Reported on every heartbeat
 * so the control plane can acknowledge installs truthfully and stale-safely.
 * `installed` means the agent wrote the material locally; `inUse` means the
 * material is actually serving (loaded by sing-box / referenced by a listener).
 */
export const certificateDeploymentSchema = z.object({
  certificateId: z.string().min(1),
  generation: z.number().int().min(1),
  fingerprintSha256: z.string().min(1).max(256),
  installed: z.boolean(),
  inUse: z.boolean(),
  errorPhase: z.string().min(1).max(64).optional(),
  errorMessage: z.string().min(1).max(16_384).optional(),
});

export const updateStateSchema = z.enum([
  "unknown",
  "idle",
  "up_to_date",
  "checking",
  "downloading",
  "verifying",
  "applying",
  "restarting",
  "failed",
  "disabled",
]);

export const updateStatusSchema = z.object({
  targetVersion: z.string().min(1).max(64).optional(),
  state: updateStateSchema,
  message: z.string().min(1).max(4096).optional(),
  checkedAt: z.iso.datetime().optional(),
});

export const heartbeatSchema = z.object({
  agentBuildId: z.string().min(1).max(256),
  agentCapabilities: z.array(z.string().min(1)).max(1024),
  agentVersion: z.string().optional(),
  singBoxVersion: z.string().optional(),
  runtimeState: z
    .enum(["unknown", "starting", "running", "stopped", "crash_loop"])
    .optional(),
  configState: z
    .enum(["unknown", "applied", "rejected", "apply_failed"])
    .optional(),
  observedRevision: z.string().max(128).optional(),
  appliedRevision: z.string().max(128).optional(),
  activeNodeIds: z.array(z.string().min(1)).max(10_000).optional(),
  clearActiveNodeIds: z.boolean().optional(),
  effectiveConfigPollIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(86_400)
    .optional(),
  effectiveHeartbeatIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(3_600)
    .optional(),
  appliedAt: z.iso.datetime().optional(),
  clearError: z.boolean().optional(),
  error: z
    .object({
      phase: z.string().min(1).max(64),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(16_384),
      nodeId: z.string().min(1).optional(),
      occurredAt: z.iso.datetime().optional(),
    })
    .optional(),
  certificateDeployments: z.array(certificateDeploymentSchema).max(10_000),
  updates: z
    .object({
      agent: updateStatusSchema.optional(),
      singBox: updateStatusSchema.optional(),
    })
    .optional(),
});

export {
  agentConfigV3OutputSchema,
  type AgentConfigV3Output,
  certificateArtifactSchema,
  type CertificateArtifact,
  formatManagedPeerTlsBindingId,
  MANAGED_NETWORKING_V2_CAPABILITY,
  MANAGED_PEER_TLS_DIRECTIONS,
  MANAGED_PEER_TLS_OWNER_KINDS,
  MANAGED_PEER_TLS_USAGES,
  MANAGED_RULE_SET_FORMATS,
  MANAGED_SNAPSHOT_LIMITS,
  MANAGED_SNAPSHOT_SCHEMA_VERSION,
  MANAGED_STAGE_INTENT_SCHEMA_VERSION,
  managedIntentOutboundSchema,
  type ManagedIntentOutbound,
  managedIntentPeerAdmissionSchema,
  type ManagedIntentPeerAdmission,
  managedIntentPeerInboundSchema,
  type ManagedIntentPeerInbound,
  managedIntentPeerTrustRefSchema,
  type ManagedIntentPeerTrustRef,
  managedIntentRouteRuleSchema,
  type ManagedIntentRouteRule,
  managedIntentSubscriberInboundSchema,
  type ManagedIntentSubscriberInbound,
  managedPeerCertificateDeploymentSchema,
  type ManagedPeerCertificateDeployment,
  managedPeerTlsBindingSchema,
  type ManagedPeerTlsBinding,
  type ManagedPeerTlsDirection,
  type ManagedPeerTlsOwnerKind,
  type ManagedPeerTlsUsage,
  managedPeerTrustArtifactSchema,
  type ManagedPeerTrustArtifact,
  managedRuleSetArtifactSchema,
  type ManagedRuleSetArtifact,
  managedRuleSetBindingSchema,
  type ManagedRuleSetBinding,
  type ManagedRuleSetFormat,
  managedSnapshotExtensionSchema,
  type ManagedSnapshotExtension,
  managedStageExpectationsSchema,
  type ManagedStageExpectations,
  managedStageIntentSchema,
  type ManagedStageIntent,
  managedTlsBindingSchema,
  type ManagedTlsBinding,
};
export type CertificateDeployment = z.infer<typeof certificateDeploymentSchema>;

/**
 * Traffic deltas the agent derives from sing-box's connection-event stream and
 * reports per user. The stream's `user` field is the inbound user identifier,
 * so each entry maps to a subscription row (and, for coded names, a node).
 *
 * `reportId` makes the report idempotent. It is chosen by the agent when it
 * seals a batch, persisted with the batch, and reused unchanged on every
 * retry; it is unique per server (the control plane scopes it by the calling
 * server). Agents that predate it omit the field and keep the legacy,
 * not-replay-safe behaviour.
 */
// The character set is enforced with a refinement rather than `.regex()`: a
// JSON-schema `pattern` makes the generated Rust client depend on `regress`,
// and the spec only needs the length bounds. Allowed: A-Z a-z 0-9 . _ -
export const trafficReportIdSchema = z
  .string()
  .min(8)
  .max(128)
  .refine((id) => /^[A-Za-z0-9._-]+$/.test(id), {
    message: "reportId may only contain letters, digits, '.', '_' and '-'",
  });

export const trafficReportSchema = z.object({
  reportId: trafficReportIdSchema.optional(),
  // Reporting window bounds as stated by the agent; optional metadata.
  windowStartedAt: z.iso.datetime().optional(),
  windowEndedAt: z.iso.datetime().optional(),
  entries: z
    .array(
      z.object({
        subscriptionId: z.string().min(1),
        uplinkBytes: z.number().int().min(0),
        downlinkBytes: z.number().int().min(0),
      }),
    )
    .max(10_000),
});

/**
 * `reportId` is echoed only when the request carried one, which is how an agent
 * tells an idempotent control plane from one that ignored the field. `duplicate`
 * is true when the id had already been applied and nothing was written again.
 */
export const trafficReportOutputSchema = z.object({
  accepted: z.number().int(),
  dropped: z.number().int(),
  reportId: z.string().optional(),
  duplicate: z.boolean().optional(),
});

export type TrafficReportInput = z.infer<typeof trafficReportSchema>;
