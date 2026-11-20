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
 * Flip it only together with the rollout gate in Task 08.
 */
export const MANAGED_NETWORKING_ACTIVATION_ENABLED = false;

/** Primary key of the singleton `managed_topology` row. */
export const MANAGED_TOPOLOGY_ID = "global";

/** Capability advertised on v2 `hello` once an agent supports managed snapshots. */
export const MANAGED_NETWORKING_AGENT_CAPABILITY =
  "managed-networking-v1" as const;

/** Schema version for `managed_config_version.intent`. */
export const MANAGED_CONFIG_INTENT_SCHEMA_VERSION = 1 as const;

/** Schema version for the V3 `managed` snapshot artifact extension. */
export const MANAGED_SNAPSHOT_EXTENSION_VERSION = 1 as const;

export const LISTENER_CLAIM_OWNER_KINDS = [
  "subscriber_inbound",
  "peer_inbound",
] as const;
export type ListenerClaimOwnerKind =
  (typeof LISTENER_CLAIM_OWNER_KINDS)[number];

/** Launch protocols for peer links (TCP with conventional TLS). */
export const PEER_PROTOCOLS = ["trojan", "vless"] as const;
export type PeerProtocol = (typeof PEER_PROTOCOLS)[number];

/**
 * Named server outbounds. The built-in `direct` outbound has no row and stays
 * the legacy default.
 */
export const MANAGED_OUTBOUND_KINDS = ["direct_profile", "peer_link"] as const;
export type ManagedOutboundKind = (typeof MANAGED_OUTBOUND_KINDS)[number];

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
  "rule_set",
] as const;
export type ManagedRuntimeObjectKind =
  (typeof MANAGED_RUNTIME_OBJECT_KINDS)[number];

const RUNTIME_TAG_PREFIX: Record<ManagedRuntimeObjectKind, string> = {
  peer_inbound: "peer-in-",
  peer_link: "peer-out-",
  direct_profile: "direct-",
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
