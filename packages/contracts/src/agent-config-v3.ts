import { z } from "zod";

/**
 * Shared V3 desired-state snapshot and pinned stage-intent contracts (Task 07:
 * snapshot compiler and agent contracts).
 *
 * Design invariants:
 * - **Legacy compatibility:** `agentConfigV3OutputSchema` preserves the exact
 *   existing V3 top-level shape (`apiVersion: 3`, `agent`, `desiredRevision`,
 *   `materializedNodeIds`, `singboxConfig`, `managedTlsBindings`,
 *   `certificateArtifacts`). The single-unit managed extension travels in the
 *   optional `managed` property and is omitted on legacy/unmanaged servers.
 * - **Progenitor / OpenAPI 3.0 safety:** Every schema reachable from
 *   `agentConfigV3OutputSchema` avoids `.regex(...)` (which emits a JSON-schema
 *   `pattern` that makes progenitor require the `regress` crate) and enforces
 *   character/format invariants through `.refine(...)` / `.superRefine(...)`.
 * - **Trust & secret minimization:**
 *   - Subscriber `managedTlsBindings` and `certificateArtifacts` (fullchain +
 *     private key) stay scoped to materialized subscriber/receiver inbounds.
 *   - Outbound sender trust for self-signed peers uses public-only
 *     `peerTrustArtifacts` (no `privateKeyPem` field). Receiver private keys
 *     never ship to a sender.
 *   - Rule-set bindings map `route.rule_set[].tag` (`rule-set-<id>`) to
 *     digest-verified binary `.srs` artifacts (`ruleSetArtifacts`), while the
 *     agent strips any control-plane `path` or `url` from `singboxConfig`.
 * - **Byte budgets:** 512 KiB raw per rule-set, 2 MiB raw aggregate per server,
 *   6 MiB serialized activation preview cap, and 8 MiB wire cap.
 */

export const AGENT_CONFIG_V3_API_VERSION = 3 as const;

export const MANAGED_NETWORKING_V2_CAPABILITY =
  "managed-networking-v1" as const;

export const MANAGED_STAGE_INTENT_SCHEMA_VERSION = 1 as const;

export const MANAGED_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const MANAGED_SNAPSHOT_LIMITS = {
  maxRuleSetAssetRawBytes: 512 * 1024,
  maxRuleSetAssetBase64Chars: Math.ceil((512 * 1024) / 3) * 4,
  maxRuleSetAggregateRawBytes: 2 * 1024 * 1024,
  maxActivationPreviewBytes: 6 * 1024 * 1024,
  maxWireSnapshotBytes: 8 * 1024 * 1024,
} as const;

function isLowercaseSha256Hex(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

function isPrefixedSha256(value: string): boolean {
  return value.startsWith("sha256:") && isLowercaseSha256Hex(value.slice(7));
}

export const sha256HexStringSchema = z
  .string()
  .min(64)
  .max(64)
  .refine(isLowercaseSha256Hex, {
    message: "Expected a 64-character lowercase hex SHA-256 digest",
  });

export const prefixedSha256Schema = z
  .string()
  .min(71)
  .max(71)
  .refine(isPrefixedSha256, {
    message: "Expected a sha256:<64-hex> digest",
  });

// --- Legacy V3 subscriber TLS bindings and certificate artifacts ------------

/**
 * One managed TLS binding for a subscriber inbound (`node-<nodeId>`).
 * Preserved unchanged for legacy V3 and subscriber certificate deployment
 * reporting.
 */
export const managedTlsBindingSchema = z.object({
  nodeId: z.string().min(1),
  inboundTag: z.string().min(1),
  certificateId: z.string().min(1),
  generation: z.number().int().min(1),
  serverName: z.string().nullable(),
});

export type ManagedTlsBinding = z.infer<typeof managedTlsBindingSchema>;

/**
 * Certificate key-pair material the agent may stage on the calling server for
 * an inbound listener (subscriber inbound or managed peer inbound).
 */
export const certificateArtifactSchema = z.object({
  certificateId: z.string().min(1),
  generation: z.number().int().min(1),
  domains: z.array(z.string().min(1)),
  fingerprintSha256: z.string().min(1).max(256),
  notBefore: z.string(),
  notAfter: z.string(),
  certificatePem: z.string().min(1),
  privateKeyPem: z.string().min(1),
});

export type CertificateArtifact = z.infer<typeof certificateArtifactSchema>;

// --- Managed peer TLS bindings, public trust artifacts & deployments --------

export const MANAGED_PEER_TLS_DIRECTIONS = ["inbound", "outbound"] as const;
export type ManagedPeerTlsDirection =
  (typeof MANAGED_PEER_TLS_DIRECTIONS)[number];

export const MANAGED_PEER_TLS_OWNER_KINDS = [
  "peer_inbound",
  "peer_outbound",
] as const;
export type ManagedPeerTlsOwnerKind =
  (typeof MANAGED_PEER_TLS_OWNER_KINDS)[number];

export const MANAGED_PEER_TLS_USAGES = [
  "identity_fullchain_and_key",
  "peer_ca_trust",
] as const;
export type ManagedPeerTlsUsage = (typeof MANAGED_PEER_TLS_USAGES)[number];

export function formatManagedPeerTlsBindingId(input: {
  direction: ManagedPeerTlsDirection;
  ownerKind: ManagedPeerTlsOwnerKind;
  ownerId: string;
  certificateId: string;
  generation: number;
}): string {
  return `peer-tls:${input.direction}:${input.ownerKind}:${input.ownerId}:${input.certificateId}:${input.generation}`;
}

function validatePeerTlsBindingParity(
  value: {
    bindingId: string;
    runtimeTag: string;
    direction: ManagedPeerTlsDirection;
    ownerKind: ManagedPeerTlsOwnerKind;
    ownerId: string;
    certificateId: string;
    generation: number;
    usage?: ManagedPeerTlsUsage;
  },
  context: z.RefinementCtx,
) {
  const expectedTag =
    value.direction === "inbound"
      ? `peer-in-${value.ownerId}`
      : `peer-out-${value.ownerId}`;
  const expectedOwnerKind =
    value.direction === "inbound" ? "peer_inbound" : "peer_outbound";
  const expectedUsage =
    value.direction === "inbound"
      ? "identity_fullchain_and_key"
      : "peer_ca_trust";

  if (value.ownerKind !== expectedOwnerKind) {
    context.addIssue({
      code: "custom",
      message: `${value.direction} peer TLS binding requires ownerKind ${expectedOwnerKind}`,
      path: ["ownerKind"],
    });
  }
  if (value.runtimeTag !== expectedTag) {
    context.addIssue({
      code: "custom",
      message: `${value.direction} peer TLS binding requires runtimeTag ${expectedTag}`,
      path: ["runtimeTag"],
    });
  }
  if (value.usage !== undefined && value.usage !== expectedUsage) {
    context.addIssue({
      code: "custom",
      message: `${value.direction} peer TLS binding requires usage ${expectedUsage}`,
      path: ["usage"],
    });
  }
  const expectedBindingId = formatManagedPeerTlsBindingId(value);
  if (value.bindingId !== expectedBindingId) {
    context.addIssue({
      code: "custom",
      message: `bindingId must equal ${expectedBindingId}`,
      path: ["bindingId"],
    });
  }
}

/**
 * Agent-owned peer TLS binding reference.
 * - `direction: "inbound"` binds a receiver peer inbound (`peer-in-<ownerId>`)
 *   to its fullchain + private key in `certificateArtifacts`.
 * - `direction: "outbound"` binds a sender peer outbound (`peer-out-<ownerId>`)
 *   to an approved public certificate in `managed.peerTrustArtifacts` (or
 *   multiple generations during self-signed trust rotation).
 */
export const managedPeerTlsBindingSchema = z
  .object({
    bindingId: z.string().min(1).max(256),
    runtimeTag: z.string().min(1).max(128),
    direction: z.enum(MANAGED_PEER_TLS_DIRECTIONS),
    ownerKind: z.enum(MANAGED_PEER_TLS_OWNER_KINDS),
    ownerId: z.string().min(1).max(128),
    certificateId: z.string().min(1).max(128),
    generation: z.number().int().min(1),
    fingerprintSha256: z.string().min(1).max(256),
    serverName: z.string().min(1).max(253),
    usage: z.enum(MANAGED_PEER_TLS_USAGES),
  })
  .superRefine(validatePeerTlsBindingParity);

export type ManagedPeerTlsBinding = z.infer<typeof managedPeerTlsBindingSchema>;

/**
 * Public-only X.509 trust artifact mounted on a sender for a self-signed peer.
 * Carries `certificatePem` only — never `privateKeyPem`.
 */
export const managedPeerTrustArtifactSchema = z.object({
  certificateId: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  domains: z.array(z.string().min(1)),
  fingerprintSha256: z.string().min(1).max(256),
  notBefore: z.string(),
  notAfter: z.string(),
  certificatePem: z.string().min(1),
});

export type ManagedPeerTrustArtifact = z.infer<
  typeof managedPeerTrustArtifactSchema
>;

/**
 * Peer certificate deployment reported by peer binding identity, kept separate
 * from subscriber `certificateDeployments` and subscriber `activeNodeIds`.
 */
export const managedPeerCertificateDeploymentSchema = z
  .object({
    bindingId: z.string().min(1).max(256),
    runtimeTag: z.string().min(1).max(128),
    direction: z.enum(MANAGED_PEER_TLS_DIRECTIONS),
    ownerKind: z.enum(MANAGED_PEER_TLS_OWNER_KINDS),
    ownerId: z.string().min(1).max(128),
    certificateId: z.string().min(1).max(128),
    generation: z.number().int().min(1),
    fingerprintSha256: z.string().min(1).max(256),
    installed: z.boolean(),
    inUse: z.boolean(),
    errorPhase: z.string().min(1).max(64).optional(),
    errorMessage: z.string().min(1).max(16_384).optional(),
  })
  .superRefine((value, context) => {
    validatePeerTlsBindingParity(value, context);
    if (value.inUse && !value.installed) {
      context.addIssue({
        code: "custom",
        message: "a peer TLS deployment cannot be inUse before it is installed",
        path: ["inUse"],
      });
    }
  });

export type ManagedPeerCertificateDeployment = z.infer<
  typeof managedPeerCertificateDeploymentSchema
>;

// --- Rule-set bindings and bounded immutable SRS artifacts ------------------

export const MANAGED_RULE_SET_FORMATS = ["binary"] as const;
export type ManagedRuleSetFormat = (typeof MANAGED_RULE_SET_FORMATS)[number];

/**
 * Tag-to-artifact binding for an agent-staged sing-box rule-set (`route.rule_set`).
 * The agent strips control-plane paths/URLs and injects its validated local
 * `.srs` path for `runtimeTag` (`rule-set-<ruleSetId>`).
 */
export const managedRuleSetBindingSchema = z
  .object({
    runtimeTag: z.string().min(1).max(128),
    ruleSetId: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    format: z.enum(MANAGED_RULE_SET_FORMATS),
    sha256: sha256HexStringSchema,
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(MANAGED_SNAPSHOT_LIMITS.maxRuleSetAssetRawBytes),
  })
  .refine((value) => value.runtimeTag === `rule-set-${value.ruleSetId}`, {
    message: "rule-set runtimeTag must equal rule-set-<ruleSetId>",
    path: ["runtimeTag"],
  });

export type ManagedRuleSetBinding = z.infer<typeof managedRuleSetBindingSchema>;

/**
 * Immutable rule-set asset payload delivered in the V3 snapshot.
 * `sizeBytes` is the exact decoded byte length (`<= 512 KiB`) and `sha256` is
 * the lowercase hex SHA-256 of those raw bytes.
 */
export const managedRuleSetArtifactSchema = z.object({
  ruleSetId: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  format: z.enum(MANAGED_RULE_SET_FORMATS),
  sha256: sha256HexStringSchema,
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(MANAGED_SNAPSHOT_LIMITS.maxRuleSetAssetRawBytes),
  contentBase64: z
    .string()
    .min(1)
    .max(MANAGED_SNAPSHOT_LIMITS.maxRuleSetAssetBase64Chars),
});

export type ManagedRuleSetArtifact = z.infer<
  typeof managedRuleSetArtifactSchema
>;

// --- Versioned single-unit managed extension on V3 output -------------------

export const managedSnapshotExtensionSchema = z
  .object({
    schemaVersion: z.literal(MANAGED_SNAPSHOT_SCHEMA_VERSION),
    configVersionId: z.string().min(1).max(128),
    intentDigest: prefixedSha256Schema,
    managedFingerprint: prefixedSha256Schema,
    tlsBindings: z.array(managedPeerTlsBindingSchema).max(1_000),
    peerTrustArtifacts: z.array(managedPeerTrustArtifactSchema).max(1_000),
    ruleSetBindings: z.array(managedRuleSetBindingSchema).max(256),
    ruleSetArtifacts: z.array(managedRuleSetArtifactSchema).max(256),
  })
  .superRefine((value, context) => {
    const seenBindingIds = new Set<string>();
    const seenInboundTags = new Set<string>();
    for (const binding of value.tlsBindings) {
      if (seenBindingIds.has(binding.bindingId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate peer TLS bindingId ${binding.bindingId}`,
          path: ["tlsBindings"],
        });
      }
      seenBindingIds.add(binding.bindingId);
      if (binding.direction === "inbound") {
        if (seenInboundTags.has(binding.runtimeTag)) {
          context.addIssue({
            code: "custom",
            message: `peer inbound ${binding.runtimeTag} cannot bind multiple certificates simultaneously`,
            path: ["tlsBindings"],
          });
        }
        seenInboundTags.add(binding.runtimeTag);
      }
    }

    const seenRuleSetTags = new Set<string>();
    for (const binding of value.ruleSetBindings) {
      if (seenRuleSetTags.has(binding.runtimeTag)) {
        context.addIssue({
          code: "custom",
          message: `duplicate rule-set runtimeTag ${binding.runtimeTag}`,
          path: ["ruleSetBindings"],
        });
      }
      seenRuleSetTags.add(binding.runtimeTag);
    }

    let aggregateRuleSetBytes = 0;
    for (const artifact of value.ruleSetArtifacts) {
      aggregateRuleSetBytes += artifact.sizeBytes;
    }
    if (
      aggregateRuleSetBytes >
      MANAGED_SNAPSHOT_LIMITS.maxRuleSetAggregateRawBytes
    ) {
      context.addIssue({
        code: "custom",
        message: `aggregate rule-set raw size ${aggregateRuleSetBytes} exceeds ${MANAGED_SNAPSHOT_LIMITS.maxRuleSetAggregateRawBytes} bytes`,
        path: ["ruleSetArtifacts"],
      });
    }
  });

export type ManagedSnapshotExtension = z.infer<
  typeof managedSnapshotExtensionSchema
>;

/**
 * V3 agent desired-state document. Fully typed except the sing-box base config
 * object itself, which the agent treats as opaque JSON.
 *
 * Legacy servers omit `managed`; managed v2 servers carry the single-unit
 * `managed` artifact and fingerprint extension.
 */
export const agentConfigV3OutputSchema = z.object({
  apiVersion: z.literal(AGENT_CONFIG_V3_API_VERSION),
  agent: z.object({
    configPollIntervalSeconds: z.number().int(),
    heartbeatIntervalSeconds: z.number().int(),
    desiredAgentVersion: z.string().min(1).max(64).optional(),
    desiredSingBoxVersion: z.string().min(1).max(64).optional(),
  }),
  desiredRevision: z.string().min(1),
  materializedNodeIds: z.array(z.string().min(1)),
  singboxConfig: z.looseObject({}),
  managedTlsBindings: z.array(managedTlsBindingSchema),
  certificateArtifacts: z.array(certificateArtifactSchema),
  managed: managedSnapshotExtensionSchema.optional(),
});

export type AgentConfigV3Output = z.infer<typeof agentConfigV3OutputSchema>;

// --- Pinned Stage Intent Contract (`managed_config_version.intent`) ---------

export const managedIntentSubscriberInboundSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    inboundTag: z.string().min(1).max(128),
    protocol: z.string().min(1).max(64),
    listenPort: z.number().int().min(1).max(65535),
    tlsServerName: z.string().min(1).max(253).nullable(),
    certificateId: z.string().min(1).max(128).nullable(),
    settingsDigest: prefixedSha256Schema,
  })
  .refine((value) => value.inboundTag === `node-${value.nodeId}`, {
    message: "subscriber inboundTag must equal node-<nodeId>",
    path: ["inboundTag"],
  });

export type ManagedIntentSubscriberInbound = z.infer<
  typeof managedIntentSubscriberInboundSchema
>;

export const managedIntentPeerAdmissionSchema = z.object({
  linkId: z.string().min(1).max(128),
  sourceServerId: z.string().min(1).max(128),
  credentialGeneration: z.number().int().min(1),
});

export type ManagedIntentPeerAdmission = z.infer<
  typeof managedIntentPeerAdmissionSchema
>;

export const managedIntentPeerInboundSchema = z
  .object({
    inboundId: z.string().min(1).max(128),
    runtimeTag: z.string().min(1).max(128),
    protocol: z.enum(["trojan", "vless"]),
    listenAddress: z.string().min(1).max(253),
    listenPort: z.number().int().min(1).max(65535),
    advertisedAddress: z.string().min(1).max(253),
    advertisedPort: z.number().int().min(1).max(65535),
    tlsServerName: z.string().min(1).max(253),
    certificateId: z.string().min(1).max(128),
    certificateGeneration: z.number().int().min(1),
    certificateFingerprintSha256: z.string().min(1).max(256),
    admissions: z.array(managedIntentPeerAdmissionSchema).max(1_000),
  })
  .refine((value) => value.runtimeTag === `peer-in-${value.inboundId}`, {
    message: "peer inbound runtimeTag must equal peer-in-<inboundId>",
    path: ["runtimeTag"],
  });

export type ManagedIntentPeerInbound = z.infer<
  typeof managedIntentPeerInboundSchema
>;

export const managedIntentPeerTrustRefSchema = z.object({
  certificateId: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  fingerprintSha256: z.string().min(1).max(256),
});

export type ManagedIntentPeerTrustRef = z.infer<
  typeof managedIntentPeerTrustRefSchema
>;

export const managedIntentOutboundSchema = z
  .object({
    outboundId: z.string().min(1).max(128),
    runtimeTag: z.string().min(1).max(128),
    kind: z.enum(["direct_profile", "peer_link"]),
    dialOptions: z.record(z.string(), z.unknown()).default({}),
    linkId: z.string().min(1).max(128).nullable().default(null),
    destinationServerId: z.string().min(1).max(128).nullable().default(null),
    destinationInboundId: z.string().min(1).max(128).nullable().default(null),
    protocol: z.enum(["trojan", "vless"]).nullable().default(null),
    serverAddress: z.string().min(1).max(253).nullable().default(null),
    serverPort: z.number().int().min(1).max(65535).nullable().default(null),
    tlsServerName: z.string().min(1).max(253).nullable().default(null),
    credentialGeneration: z.number().int().min(1).nullable().default(null),
    trustMode: z
      .enum(["system", "managed_certificate"])
      .nullable()
      .default(null),
    trustedCertificates: z
      .array(managedIntentPeerTrustRefSchema)
      .max(4)
      .default([]),
  })
  .superRefine((value, context) => {
    const expectedTag =
      value.kind === "direct_profile"
        ? `direct-${value.outboundId}`
        : `peer-out-${value.outboundId}`;
    if (value.runtimeTag !== expectedTag) {
      context.addIssue({
        code: "custom",
        message: `${value.kind} outbound requires runtimeTag ${expectedTag}`,
        path: ["runtimeTag"],
      });
    }
    if (value.kind === "direct_profile") {
      if (value.linkId !== null || value.trustedCertificates.length > 0) {
        context.addIssue({
          code: "custom",
          message: "direct_profile outbounds cannot carry peer link fields",
          path: ["kind"],
        });
      }
      return;
    }
    if (
      value.linkId === null ||
      value.destinationServerId === null ||
      value.destinationInboundId === null ||
      value.protocol === null ||
      value.serverAddress === null ||
      value.serverPort === null ||
      value.tlsServerName === null ||
      value.credentialGeneration === null ||
      value.trustMode === null
    ) {
      context.addIssue({
        code: "custom",
        message: "peer_link outbound is missing required peer endpoint fields",
        path: ["kind"],
      });
      return;
    }
    if (
      value.trustMode === "managed_certificate" &&
      value.trustedCertificates.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "managed_certificate trustMode requires at least one trusted certificate reference",
        path: ["trustedCertificates"],
      });
    }
    if (value.trustMode === "system" && value.trustedCertificates.length > 0) {
      context.addIssue({
        code: "custom",
        message: "system trustMode cannot carry pinned certificate references",
        path: ["trustedCertificates"],
      });
    }
  });

export type ManagedIntentOutbound = z.infer<typeof managedIntentOutboundSchema>;

export const managedIntentRouteRuleSchema = z
  .object({
    ruleId: z.string().min(1).max(128),
    inboundTags: z.array(z.string().min(1).max(128)).min(1).max(256),
    sniff: z.boolean().default(false),
    resolveStrategy: z
      .enum(["prefer_ipv4", "prefer_ipv6", "ipv4_only", "ipv6_only"])
      .nullable()
      .default(null),
    network: z.enum(["tcp", "udp"]).nullable().default(null),
    domains: z.array(z.string().min(1)).max(1_000).default([]),
    domainSuffixes: z.array(z.string().min(1)).max(1_000).default([]),
    domainKeywords: z.array(z.string().min(1)).max(1_000).default([]),
    ipCidrs: z.array(z.string().min(1)).max(1_000).default([]),
    ports: z.array(z.number().int().min(1).max(65535)).max(256).default([]),
    ruleSetTags: z.array(z.string().min(1).max(128)).max(64).default([]),
    action: z.enum(["route", "reject"]),
    outboundTag: z.string().min(1).max(128).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.action === "route" && value.outboundTag === null) {
      context.addIssue({
        code: "custom",
        message: "route action requires an outboundTag",
        path: ["outboundTag"],
      });
    }
    if (value.action === "reject" && value.outboundTag !== null) {
      context.addIssue({
        code: "custom",
        message: "reject action cannot carry an outboundTag",
        path: ["outboundTag"],
      });
    }
  });

export type ManagedIntentRouteRule = z.infer<
  typeof managedIntentRouteRuleSchema
>;

export const managedStageExpectationsSchema = z
  .object({
    requiredRuntimeTags: z.array(z.string().min(1).max(128)).max(2_000),
    removedRuntimeTags: z.array(z.string().min(1).max(128)).max(2_000),
  })
  .superRefine((value, context) => {
    const required = new Set(value.requiredRuntimeTags);
    for (const removed of value.removedRuntimeTags) {
      if (required.has(removed)) {
        context.addIssue({
          code: "custom",
          message: `runtimeTag ${removed} cannot be both required and removed in the same stage`,
          path: ["removedRuntimeTags"],
        });
      }
    }
  });

export type ManagedStageExpectations = z.infer<
  typeof managedStageExpectationsSchema
>;

export const managedStageIntentSchema = z.object({
  schemaVersion: z.literal(MANAGED_STAGE_INTENT_SCHEMA_VERSION),
  configVersionId: z.string().min(1).max(128),
  serverId: z.string().min(1).max(128),
  version: z.number().int().min(1),
  topologyGeneration: z.number().int().min(0),
  subscriberInbounds: z.array(managedIntentSubscriberInboundSchema).max(1_000),
  peerInbounds: z.array(managedIntentPeerInboundSchema).max(1_000),
  outbounds: z.array(managedIntentOutboundSchema).max(1_000),
  routingPolicy: z.object({
    rules: z.array(managedIntentRouteRuleSchema).max(2_000),
    finalOutboundTag: z.string().min(1).max(128).default("direct"),
  }),
  ruleSets: z.array(managedRuleSetBindingSchema).max(256),
  stageExpectations: managedStageExpectationsSchema,
});

export type ManagedStageIntent = z.infer<typeof managedStageIntentSchema>;
