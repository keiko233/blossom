/**
 * Pure state helpers for the server Connection tab. The UI must report what
 * the control plane actually knows (grant and identity rows plus the deployed
 * agent's status), never infer success from a downloaded installer.
 */

/** A redemption claim older than this is treated as an interrupted attempt. */
export const REDEMPTION_STALE_MS = 5 * 60_000;

export interface EnrollmentGrantLike {
  id: string;
  status: string;
  createdAt: Date | string;
  claimedAt?: Date | string | null;
  expiresAt: Date | string;
}

export interface AgentIdentityLike {
  status: string;
}

export interface IdentityGenerationLike {
  status: string;
  generation: number;
}

/**
 * The generation that owns the agent lane and the generation trying to
 * replace or install into it. Both can exist during a rotation; the active
 * one stays authoritative until the pending one proves its handshake.
 */
export function currentIdentities<T extends IdentityGenerationLike>(
  identities: readonly T[],
): { active: T | null; pending: T | null } {
  return {
    active: identities.find((identity) => identity.status === "active") ?? null,
    pending:
      identities.find((identity) => identity.status === "pending") ?? null,
  };
}

export type GrantDisplayStatus =
  | "issued"
  | "expired"
  | "redeeming"
  | "redeemed"
  | "revoked";

function timeOf(value: Date | string | null | undefined): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }
  return new Date(value).getTime();
}

export function grantDisplayStatus(
  grant: EnrollmentGrantLike,
  now = Date.now(),
): GrantDisplayStatus {
  if (grant.status === "issued") {
    return timeOf(grant.expiresAt) <= now ? "expired" : "issued";
  }
  switch (grant.status) {
    case "redeeming":
      return "redeeming";
    case "redeemed":
      return "redeemed";
    default:
      return "revoked";
  }
}

export function latestEnrollmentGrant<T extends EnrollmentGrantLike>(
  grants: readonly T[],
): T | undefined {
  return [...grants].sort(
    (left, right) => timeOf(right.createdAt) - timeOf(left.createdAt),
  )[0];
}

export type InstallationPhase =
  | "not_started"
  | "grant_ready"
  | "redeeming"
  | "failed"
  | "pending_activation"
  | "active"
  | "expired"
  | "revoked";

export interface InstallationPhaseInput {
  identities: readonly AgentIdentityLike[];
  grants: readonly EnrollmentGrantLike[];
}

/**
 * Summarises install progress from persisted control-plane state.
 *
 * - `pending_activation` means credentials exist but the identity has not been
 *   promoted; it is not a finished installation.
 * - `failed` covers an interrupted redemption or a redeemed grant whose
 *   identity is no longer pending or active.
 * - `expired` and `revoked` are retryable states, not installation success.
 */
export function installationPhase(
  input: InstallationPhaseInput,
  now = Date.now(),
): InstallationPhase {
  if (input.identities.some((identity) => identity.status === "active")) {
    return "active";
  }
  if (input.identities.some((identity) => identity.status === "pending")) {
    return "pending_activation";
  }

  const grant = latestEnrollmentGrant(input.grants);
  if (!grant) {
    return "not_started";
  }

  const displayStatus = grantDisplayStatus(grant, now);
  switch (displayStatus) {
    case "issued":
      return "grant_ready";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "redeemed":
      return "failed";
    case "redeeming": {
      const claimedAt = timeOf(grant.claimedAt ?? grant.createdAt);
      return now - claimedAt > REDEMPTION_STALE_MS ? "failed" : "redeeming";
    }
  }
}

export type EnrollmentCreateBlock =
  | "server_disabled"
  | "pending_identity"
  | null;

/**
 * Reasons a new enroll or replace grant cannot be created. An active identity
 * does not block a replacement; the backend keeps it active until the pending
 * generation proves its handshake.
 */
export function enrollmentCreateBlock(input: {
  serverEnabled: boolean;
  identities: readonly AgentIdentityLike[];
}): EnrollmentCreateBlock {
  if (!input.serverEnabled) {
    return "server_disabled";
  }
  if (input.identities.some((identity) => identity.status === "pending")) {
    return "pending_identity";
  }
  return null;
}
