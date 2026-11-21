/**
 * Portable vocabulary for managed networking persistence (Task 06: managed
 * persistence and writer boundary). The tables live in
 * `app/src/db/managed-network-schema.ts`; these constants stay free of
 * database imports so the admin UI can share them.
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

type ManagedRuntimeObjectKind = "peer_inbound" | ManagedOutboundKind;

const RUNTIME_TAG_PREFIX: Record<ManagedRuntimeObjectKind, string> = {
  peer_inbound: "peer-in-",
  peer_link: "peer-out-",
  direct_profile: "direct-",
};

/**
 * Immutable sing-box tag derived from a managed object's identity. Display
 * names never feed it. The prefixes cannot collide with subscriber inbounds
 * (`node-<id>`) or the built-in `direct` outbound.
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
