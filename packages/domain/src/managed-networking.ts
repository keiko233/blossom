/**
 * Portable vocabulary for managed networking persistence (Task 06: managed
 * persistence and writer boundary) and snapshot compilation (Task 07: snapshot
 * compiler and agent contracts). The tables live in
 * `app/src/db/managed-network-schema.ts`; these constants and pure helpers stay
 * free of database imports so contracts, the compiler and the admin UI can
 * share them.
 */

/**
 * Single switch for managed networking activation. While false, no writer may
 * create a rollout, advance a stage pointer or claim a listener for a peer
 * resource, and every compile path keeps the legacy single-direct snapshot.
 * Enabled by default. Rollouts still require explicit administrator admission.
 */
export const MANAGED_NETWORKING_ACTIVATION_ENABLED = true;

/** Primary key of the singleton `managed_topology` row. */
export const MANAGED_TOPOLOGY_ID = "global";

/** Capability advertised on v2 `hello` once an agent supports managed snapshots. */
export const MANAGED_NETWORKING_AGENT_CAPABILITY =
  "managed-networking-v1" as const;

/**
 * Minimum sing-box release for managed activation. The managed canary runs on
 * the pinned 1.14.4 test binary; 1.14 is the floor for the stats/probe runtime
 * surface the surrounding rollout workflow relies on.
 */
export const MANAGED_NETWORKING_MIN_SING_BOX_VERSION = "1.14.0" as const;

const MIN_SING_BOX_VERSION_PARTS = [1, 14, 0] as const;

export interface SingBoxVersionParts {
  major: number;
  minor: number;
  patch: number;
}

/** Parses the agent-reported `sing-box version`; unknown formats return null. */
export function parseSingBoxVersion(
  value: string | null | undefined,
): SingBoxVersionParts | null {
  if (!value) return null;
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export type ManagedNetworkingReadinessReason =
  | "server_disabled"
  | "agent_offline"
  | "capability_missing"
  | "sing_box_version_unknown"
  | "sing_box_version_unsupported"
  | "runtime_state_unknown"
  | "runtime_not_running"
  | "config_state_unknown"
  | "config_not_applied"
  | "managed_state_unsettled";

export interface ManagedNetworkingReadinessInput {
  enabled: boolean;
  agentConnected: boolean;
  agentCapabilities: readonly string[];
  singBoxVersion: string | null;
  runtimeState: string;
  configState: string;
  desiredConfigVersionId: string | null;
  appliedConfigVersionId: string | null;
}

export interface ManagedNetworkingReadiness {
  ready: boolean;
  reasons: ManagedNetworkingReadinessReason[];
  minSingBoxVersion: typeof MANAGED_NETWORKING_MIN_SING_BOX_VERSION;
}

/**
 * Admission readiness for one affected server. Missing or unknown state blocks
 * activation instead of being treated as compatible. Capability, runtime,
 * applied config and an unsettled managed pointer are independent checks so the
 * operator can see every reason rather than only the first.
 */
export function evaluateManagedNetworkingReadiness(
  input: ManagedNetworkingReadinessInput,
): ManagedNetworkingReadiness {
  const reasons: ManagedNetworkingReadinessReason[] = [];
  if (!input.enabled) reasons.push("server_disabled");
  if (!input.agentConnected) reasons.push("agent_offline");
  if (!input.agentCapabilities.includes(MANAGED_NETWORKING_AGENT_CAPABILITY)) {
    reasons.push("capability_missing");
  }

  const version = parseSingBoxVersion(input.singBoxVersion);
  if (!version) {
    reasons.push("sing_box_version_unknown");
  } else {
    const minimum = MIN_SING_BOX_VERSION_PARTS;
    const supported =
      version.major > minimum[0] ||
      (version.major === minimum[0] && version.minor > minimum[1]) ||
      (version.major === minimum[0] &&
        version.minor === minimum[1] &&
        version.patch >= minimum[2]);
    if (!supported) reasons.push("sing_box_version_unsupported");
  }

  if (input.runtimeState === "unknown") {
    reasons.push("runtime_state_unknown");
  } else if (input.runtimeState !== "running") {
    reasons.push("runtime_not_running");
  }
  if (input.configState === "unknown") {
    reasons.push("config_state_unknown");
  } else if (input.configState !== "applied") {
    reasons.push("config_not_applied");
  }
  if (
    input.desiredConfigVersionId !== null &&
    input.desiredConfigVersionId !== input.appliedConfigVersionId
  ) {
    reasons.push("managed_state_unsettled");
  }

  return {
    ready: reasons.length === 0,
    reasons,
    minSingBoxVersion: MANAGED_NETWORKING_MIN_SING_BOX_VERSION,
  };
}

/** Schema version for `managed_config_version.intent`. */
export const MANAGED_CONFIG_INTENT_SCHEMA_VERSION = 1 as const;

/** Schema version for the V3 `managed` snapshot artifact extension. */
export const MANAGED_SNAPSHOT_EXTENSION_VERSION = 1 as const;

export const LISTENER_CLAIM_OWNER_KINDS = [
  "subscriber_inbound",
  "peer_inbound",
  "port_forward",
] as const;
export type ListenerClaimOwnerKind =
  (typeof LISTENER_CLAIM_OWNER_KINDS)[number];

/** Supported protocols for inter-server peer links. */
export const PEER_PROTOCOLS = [
  "vless",
  "trojan",
  "shadowsocks",
  "socks",
  "vmess",
  "hysteria2",
  "tuic",
  "anytls",
  "naive",
  "hysteria",
  "shadowtls",
] as const;
export type PeerProtocol = (typeof PEER_PROTOCOLS)[number];

export const PEER_NETWORKS = ["tcp", "udp", "both"] as const;
export type PeerNetwork = (typeof PEER_NETWORKS)[number];

export type PeerTlsMode = "required" | "optional" | "none";
export type PeerCredentialKind =
  | "uuid"
  | "password"
  | "username_password"
  | "uuid_password";

export interface PeerProtocolCapability {
  protocol: PeerProtocol;
  supportsUdp: boolean;
  tlsMode: PeerTlsMode;
  defaultNetwork: PeerNetwork;
  credentialKind: PeerCredentialKind;
  /** True when the protocol uses QUIC/UDP as its transport (e.g. hysteria2, tuic). */
  quicTransport: boolean;
}

const PEER_PROTOCOL_CAPABILITIES: Record<PeerProtocol, PeerProtocolCapability> =
  {
    vless: {
      protocol: "vless",
      supportsUdp: true,
      tlsMode: "optional",
      defaultNetwork: "both",
      credentialKind: "uuid",
      quicTransport: false,
    },
    trojan: {
      protocol: "trojan",
      supportsUdp: true,
      tlsMode: "required",
      defaultNetwork: "both",
      credentialKind: "password",
      quicTransport: false,
    },
    shadowsocks: {
      protocol: "shadowsocks",
      supportsUdp: true,
      tlsMode: "none",
      defaultNetwork: "both",
      credentialKind: "password",
      quicTransport: false,
    },
    socks: {
      protocol: "socks",
      supportsUdp: true,
      tlsMode: "none",
      defaultNetwork: "both",
      credentialKind: "username_password",
      quicTransport: false,
    },
    vmess: {
      protocol: "vmess",
      supportsUdp: true,
      tlsMode: "optional",
      defaultNetwork: "both",
      credentialKind: "uuid",
      quicTransport: false,
    },
    hysteria2: {
      protocol: "hysteria2",
      supportsUdp: true,
      tlsMode: "required",
      defaultNetwork: "both",
      credentialKind: "password",
      quicTransport: true,
    },
    tuic: {
      protocol: "tuic",
      supportsUdp: true,
      tlsMode: "required",
      defaultNetwork: "both",
      credentialKind: "uuid_password",
      quicTransport: true,
    },
    anytls: {
      protocol: "anytls",
      supportsUdp: true,
      tlsMode: "required",
      defaultNetwork: "both",
      credentialKind: "password",
      quicTransport: false,
    },
    naive: {
      protocol: "naive",
      supportsUdp: false,
      tlsMode: "required",
      defaultNetwork: "tcp",
      credentialKind: "username_password",
      quicTransport: false,
    },
    hysteria: {
      protocol: "hysteria",
      supportsUdp: true,
      tlsMode: "required",
      defaultNetwork: "both",
      credentialKind: "password",
      quicTransport: true,
    },
    shadowtls: {
      protocol: "shadowtls",
      supportsUdp: false,
      tlsMode: "none",
      defaultNetwork: "tcp",
      credentialKind: "password",
      quicTransport: false,
    },
  };

export function isPeerProtocol(value: string): value is PeerProtocol {
  return (PEER_PROTOCOLS as readonly string[]).includes(value);
}

export function peerProtocolCapability(
  protocol: PeerProtocol,
): PeerProtocolCapability {
  return PEER_PROTOCOL_CAPABILITIES[protocol];
}

/**
 * Named server outbounds. The built-in `direct` outbound has no row and stays
 * the legacy default.
 */
export const MANAGED_OUTBOUND_KINDS = [
  "direct_profile",
  "peer_link",
  "custom_proxy",
  "outbound_group",
] as const;
export type ManagedOutboundKind = (typeof MANAGED_OUTBOUND_KINDS)[number];

export const OUTBOUND_GROUP_PROTOCOLS = ["selector", "urltest"] as const;
export type OutboundGroupProtocol = (typeof OUTBOUND_GROUP_PROTOCOLS)[number];

/**
 * IP-family choices a named direct profile may pin. `any` leaves the sing-box
 * dial defaults untouched; the other values map to validated `inet4`/`inet6`
 * bind fields at render time.
 */
export const MANAGEABLE_OUTBOUND_IP_FAMILIES = ["any", "ipv4", "ipv6"] as const;
export type ManageableOutboundIpFamily =
  (typeof MANAGEABLE_OUTBOUND_IP_FAMILIES)[number];

/**
 * Maps a named direct profile's IP-family choice to the sing-box `direct`
 * outbound dial field. `any` contributes no field.
 */
export function directProfileIpFamilyDialFields(
  family: ManageableOutboundIpFamily,
): Record<string, boolean> {
  switch (family) {
    case "any":
      return {};
    case "ipv4":
      return { inet6: false };
    case "ipv6":
      return { inet4: false };
  }
}

export const PEER_CREDENTIAL_STATES = [
  "active",
  "retiring",
  "retired",
] as const;
export type PeerCredentialState = (typeof PEER_CREDENTIAL_STATES)[number];

export const MANAGED_ROLLOUT_STATES = [
  "applying",
  "stalled",
  "recovering",
  "completed",
  "failed",
  "aborted",
] as const;
export type ManagedRolloutState = (typeof MANAGED_ROLLOUT_STATES)[number];

export const MANAGED_STAGE_STATES = [
  "pending",
  "issued",
  "confirmed",
  "failed",
  "superseded",
] as const;
export type ManagedStageState = (typeof MANAGED_STAGE_STATES)[number];

/** Built-in legacy direct outbound tag. */
export const BUILTIN_DIRECT_OUTBOUND_TAG = "direct" as const;

/** Prefix used by subscriber inbounds compiled from `node` rows. */
export const SUBSCRIBER_INBOUND_TAG_PREFIX = "node-" as const;

/**
 * Prefix reserved for agent-owned local runtime endpoints (such as the
 * loopback link-probe ingress, responder, and internal services).
 */
export const AGENT_OWNED_TAG_PREFIX = "blossom-agent-" as const;

export const MANAGED_RUNTIME_OBJECT_KINDS = [
  "peer_inbound",
  "peer_link",
  "direct_profile",
  "port_forward",
  "custom_proxy",
  "outbound_group",
  "rule_set",
] as const;
export type ManagedRuntimeObjectKind =
  (typeof MANAGED_RUNTIME_OBJECT_KINDS)[number];

const RUNTIME_TAG_PREFIX: Record<ManagedRuntimeObjectKind, string> = {
  peer_inbound: "peer-in-",
  peer_link: "peer-out-",
  direct_profile: "direct-",
  port_forward: "relay-in-",
  custom_proxy: "custom-out-",
  outbound_group: "group-out-",
  rule_set: "rule-set-",
};

/**
 * Immutable sing-box tag derived from a managed object's identity. Display
 * names never feed it. The prefixes cannot collide with subscriber inbounds
 * (`node-<id>`), agent-owned tags (`blossom-agent-*`) or the built-in `direct`
 * outbound.
 */
export function managedRuntimeTag(
  kind: ManagedRuntimeObjectKind,
  id: string,
): string {
  if (id.length === 0) {
    throw new Error("Managed runtime object id must not be empty");
  }
  return `${RUNTIME_TAG_PREFIX[kind]}${id}`;
}

/** Stable sing-box inbound tag for a subscriber node (`node-<id>`). */
export function subscriberInboundTag(nodeId: string): string {
  if (nodeId.length === 0) {
    throw new Error("Subscriber node id must not be empty");
  }
  return `${SUBSCRIBER_INBOUND_TAG_PREFIX}${nodeId}`;
}

/** Reserved sing-box runtime tag owned locally by `server-agent`. */
export function agentOwnedRuntimeTag(purpose: string): string {
  if (purpose.length === 0) {
    throw new Error("Agent-owned runtime tag purpose must not be empty");
  }
  return `${AGENT_OWNED_TAG_PREFIX}${purpose}`;
}

export type RuntimeTagClassification =
  | { kind: "builtin_direct"; tag: typeof BUILTIN_DIRECT_OUTBOUND_TAG }
  | { kind: "subscriber_inbound"; id: string; tag: string }
  | { kind: ManagedRuntimeObjectKind; id: string; tag: string }
  | { kind: "agent_owned"; purpose: string; tag: string };

/**
 * Classifies a sing-box runtime tag into its owning namespace, or returns
 * `null` if the tag does not match a valid reserved Blossom runtime prefix.
 */
export function classifyManagedRuntimeTag(
  tag: string,
): RuntimeTagClassification | null {
  if (tag === BUILTIN_DIRECT_OUTBOUND_TAG) {
    return { kind: "builtin_direct", tag: BUILTIN_DIRECT_OUTBOUND_TAG };
  }
  if (tag.startsWith(AGENT_OWNED_TAG_PREFIX)) {
    const purpose = tag.slice(AGENT_OWNED_TAG_PREFIX.length);
    return purpose.length > 0 ? { kind: "agent_owned", purpose, tag } : null;
  }
  if (tag.startsWith(SUBSCRIBER_INBOUND_TAG_PREFIX)) {
    const id = tag.slice(SUBSCRIBER_INBOUND_TAG_PREFIX.length);
    return id.length > 0 ? { kind: "subscriber_inbound", id, tag } : null;
  }
  for (const kind of MANAGED_RUNTIME_OBJECT_KINDS) {
    const prefix = RUNTIME_TAG_PREFIX[kind];
    if (tag.startsWith(prefix)) {
      const id = tag.slice(prefix.length);
      return id.length > 0 ? { kind, id, tag } : null;
    }
  }
  return null;
}

/**
 * True when `tag` collides with any reserved Blossom or agent-owned tag
 * namespace (`direct`, `blossom-agent-*`, `node-*`, `peer-in-*`, `peer-out-*`,
 * `direct-*`, `rule-set-*`), including bare prefixes with an empty suffix.
 */
export function isReservedRuntimeTag(tag: string): boolean {
  if (tag === BUILTIN_DIRECT_OUTBOUND_TAG) {
    return true;
  }
  if (
    tag.startsWith(AGENT_OWNED_TAG_PREFIX) ||
    tag.startsWith(SUBSCRIBER_INBOUND_TAG_PREFIX)
  ) {
    return true;
  }
  return MANAGED_RUNTIME_OBJECT_KINDS.some((kind) =>
    tag.startsWith(RUNTIME_TAG_PREFIX[kind]),
  );
}

/**
 * Snapshot size budgets per spec:
 * - 512 KiB raw per rule-set asset
 * - 2 MiB raw aggregate across all rule-set assets on one server
 * - 6 MiB serialized JSON budget for managed activation previews (including
 *   base64 encoding overhead and certificate material)
 * - 8 MiB hard wire cap on live V3 snapshots (`AGENT_WS_V2_LIMITS.maxSnapshotBytes`)
 */
export const MANAGED_SNAPSHOT_BYTE_BUDGETS = {
  maxRuleSetAssetRawBytes: 512 * 1024,
  maxRuleSetAggregateRawBytes: 2 * 1024 * 1024,
  maxActivationPreviewSerializedBytes: 6 * 1024 * 1024,
  maxLiveSnapshotWireBytes: 8 * 1024 * 1024,
} as const;

export type ManagedSnapshotBudgetStage = "activation_preview" | "live_compile";

export interface ManagedRuleSetSizeEntry {
  ruleSetId: string;
  rawBytes: number;
}

export type ManagedSnapshotBudgetViolation =
  | {
      code: "rule_set_asset_too_large";
      ruleSetId: string;
      actualBytes: number;
      limitBytes: number;
    }
  | {
      code: "rule_set_aggregate_too_large";
      actualBytes: number;
      limitBytes: number;
    }
  | {
      code: "preview_budget_exceeded";
      actualBytes: number;
      limitBytes: number;
    }
  | {
      code: "wire_cap_exceeded";
      actualBytes: number;
      limitBytes: number;
    };

export interface ManagedSnapshotBudgetEvaluation {
  ok: boolean;
  stage: ManagedSnapshotBudgetStage;
  ruleSetCount: number;
  maxSingleRuleSetRawBytes: number;
  aggregateRuleSetRawBytes: number;
  serializedSnapshotBytes: number;
  effectiveSerializedLimitBytes: number;
  violations: ManagedSnapshotBudgetViolation[];
}

/** Standard base64 byte length (`ceil(n / 3) * 4`) for raw asset budgeting. */
export function estimateBase64EncodedBytes(rawBytes: number): number {
  if (!Number.isInteger(rawBytes) || rawBytes < 0) {
    throw new Error("rawBytes must be a non-negative integer");
  }
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Evaluates per-asset, aggregate-asset, preview (6 MiB) and live wire (8 MiB)
 * byte budgets for a compiled V3 snapshot.
 */
export function evaluateManagedSnapshotByteBudget(input: {
  stage: ManagedSnapshotBudgetStage;
  ruleSets: readonly ManagedRuleSetSizeEntry[];
  serializedSnapshotBytes: number;
}): ManagedSnapshotBudgetEvaluation {
  const violations: ManagedSnapshotBudgetViolation[] = [];
  let maxSingleRuleSetRawBytes = 0;
  let aggregateRuleSetRawBytes = 0;

  for (const entry of input.ruleSets) {
    if (entry.rawBytes > maxSingleRuleSetRawBytes) {
      maxSingleRuleSetRawBytes = entry.rawBytes;
    }
    aggregateRuleSetRawBytes += entry.rawBytes;
    if (
      entry.rawBytes > MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes
    ) {
      violations.push({
        code: "rule_set_asset_too_large",
        ruleSetId: entry.ruleSetId,
        actualBytes: entry.rawBytes,
        limitBytes: MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes,
      });
    }
  }

  if (
    aggregateRuleSetRawBytes >
    MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAggregateRawBytes
  ) {
    violations.push({
      code: "rule_set_aggregate_too_large",
      actualBytes: aggregateRuleSetRawBytes,
      limitBytes: MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAggregateRawBytes,
    });
  }

  if (
    input.stage === "activation_preview" &&
    input.serializedSnapshotBytes >
      MANAGED_SNAPSHOT_BYTE_BUDGETS.maxActivationPreviewSerializedBytes
  ) {
    violations.push({
      code: "preview_budget_exceeded",
      actualBytes: input.serializedSnapshotBytes,
      limitBytes:
        MANAGED_SNAPSHOT_BYTE_BUDGETS.maxActivationPreviewSerializedBytes,
    });
  }

  if (
    input.serializedSnapshotBytes >
    MANAGED_SNAPSHOT_BYTE_BUDGETS.maxLiveSnapshotWireBytes
  ) {
    violations.push({
      code: "wire_cap_exceeded",
      actualBytes: input.serializedSnapshotBytes,
      limitBytes: MANAGED_SNAPSHOT_BYTE_BUDGETS.maxLiveSnapshotWireBytes,
    });
  }

  const effectiveSerializedLimitBytes =
    input.stage === "activation_preview"
      ? MANAGED_SNAPSHOT_BYTE_BUDGETS.maxActivationPreviewSerializedBytes
      : MANAGED_SNAPSHOT_BYTE_BUDGETS.maxLiveSnapshotWireBytes;

  return {
    ok: violations.length === 0,
    stage: input.stage,
    ruleSetCount: input.ruleSets.length,
    maxSingleRuleSetRawBytes,
    aggregateRuleSetRawBytes,
    serializedSnapshotBytes: input.serializedSnapshotBytes,
    effectiveSerializedLimitBytes,
    violations,
  };
}
