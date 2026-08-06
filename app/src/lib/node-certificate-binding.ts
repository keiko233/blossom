import type { certificateServer } from "@/db/proxy-schema";

/**
 * Pure planners for the managed-TLS node workflow. A node's certificate
 * selection ("bind and use") drives the internal `certificate_server` row: the
 * row is enabled exactly while at least one node on that server uses the
 * certificate, and it carries the certificate's current desired generation
 * plus truthful V3 acknowledgement state. Keeping the decision logic here makes
 * the create/update handlers in `@/query/nodes` thin and unit-testable.
 */

export interface BindingSnapshot {
  enabled: boolean;
  desiredGeneration: number;
}

export type BindingUpsertPlan =
  | { kind: "noop" }
  | { kind: "insert"; desiredGeneration: number }
  | { kind: "re-enable"; desiredGeneration: number }
  | { kind: "advance"; desiredGeneration: number };

/**
 * Decides what a bind-and-use write must do to the `(certificateId, serverId)`
 * row for the certificate's current desired generation:
 * - no row → insert one with pending acknowledgement state;
 * - a disabled row → re-enable it and reset to pending (any ack is stale);
 * - an enabled row on a different generation → advance the desired generation
 *   and drop the applied/error acknowledgement (the material must be
 *   re-provisioned by the agent);
 * - an enabled row already on the certificate's generation → noop, preserving
 *   any acknowledgement still owed to another node on the same binding.
 */
export function planBindingUpsert(
  binding: BindingSnapshot | null,
  certificateDesiredGeneration: number,
): BindingUpsertPlan {
  if (!binding) {
    return { kind: "insert", desiredGeneration: certificateDesiredGeneration };
  }
  if (!binding.enabled) {
    return {
      kind: "re-enable",
      desiredGeneration: certificateDesiredGeneration,
    };
  }
  if (binding.desiredGeneration !== certificateDesiredGeneration) {
    return {
      kind: "advance",
      desiredGeneration: certificateDesiredGeneration,
    };
  }
  return { kind: "noop" };
}

/**
 * Whether a binding state change is one this request "created": only those can
 * be safely undone with evidence-based compensation if node persistence fails.
 */
export function isNewlyActivatedBinding(
  plan: BindingUpsertPlan | null,
): boolean {
  return plan?.kind === "insert" || plan?.kind === "re-enable";
}

type CertificateServerWrite = Partial<typeof certificateServer.$inferInsert>;

/**
 * The non-key fields to write for a bind-and-use plan. `insert` and `re-enable`
 * reset the whole acknowledgement block to pending; `advance` keeps the
 * installed material metadata (the agent still has it on disk) while dropping
 * the applied/in-use/error acknowledgement that no longer matches the desired
 * generation.
 */
export function bindingUpsertWrite(
  plan: Exclude<BindingUpsertPlan, { kind: "noop" }>,
): CertificateServerWrite {
  const base: CertificateServerWrite = {
    enabled: true,
    desiredGeneration: plan.desiredGeneration,
    state: "pending",
    appliedGeneration: null,
    inUseAt: null,
    lastErrorPhase: null,
    lastError: null,
  };
  if (plan.kind === "advance") {
    return base;
  }
  return {
    ...base,
    installedGeneration: null,
    installedFingerprintSha256: null,
    installedAt: null,
  };
}

/**
 * What a clean-up writes when a binding is no longer referenced by any node on
 * the server. The binding stays in place (row identity is stable) but is
 * disabled; the agent stops provisioning the material on the next poll.
 */
export const BINDING_DISABLE_WRITE: CertificateServerWrite = {
  enabled: false,
  state: "pending",
  appliedGeneration: null,
  inUseAt: null,
  lastErrorPhase: null,
  lastError: null,
};

/**
 * Reset acknowledgement fields whenever a binding advances to another desired
 * certificate generation. Installed metadata is intentionally retained: it
 * truthfully describes what is still on disk until the agent reports the new
 * generation, while applied/in-use/error state must never cross generations.
 */
export const BINDING_GENERATION_RESET_WRITE: CertificateServerWrite = {
  state: "pending",
  appliedGeneration: null,
  inUseAt: null,
  lastErrorPhase: null,
  lastError: null,
};

/**
 * A binding may be disabled only when no other node on the server still uses
 * the certificate. `binding` is the row itself (may be absent), and
 * `otherNodesUsingCertificate` the precise count of nodes that actually serve
 * it. Never disable a row another node still depends on.
 */
export function shouldDisableBinding(
  binding: Pick<BindingSnapshot, "enabled"> | null,
  otherNodesUsingCertificate: number,
): boolean {
  return (
    binding !== null && binding.enabled && otherNodesUsingCertificate === 0
  );
}

export type CertificateDeploymentStatus =
  | "pending"
  | "installed"
  | "in_use"
  | "error";

export interface CertificateDeploymentInfo {
  status: CertificateDeploymentStatus;
  phase: string | null;
  message: string | null;
}

/**
 * Classifies a binding's per-server deployment state from the truthful V3
 * acknowledgement fields. A certificate is never "in use" merely because it was
 * issued: only an accepted, currently-serving deployment whose installed and
 * applied generations both match the desired generation and has an explicit
 * `inUseAt` acknowledgement is. An explicit error wins over everything else;
 * matching installed material that is not serving is "installed"; everything
 * else is still awaiting install.
 */
export function describeCertificateDeployment(binding: {
  enabled: boolean;
  state: string;
  desiredGeneration: number;
  installedGeneration: number | null;
  installedFingerprintSha256: string | null;
  appliedGeneration: number | null;
  inUseAt: Date | null;
  lastErrorPhase: string | null;
  lastError: string | null;
}): CertificateDeploymentInfo {
  if (!binding.enabled) {
    return { status: "pending", phase: null, message: null };
  }
  if (
    binding.state === "error" ||
    binding.lastErrorPhase !== null ||
    binding.lastError !== null
  ) {
    return {
      status: "error",
      phase: binding.lastErrorPhase,
      message: binding.lastError,
    };
  }
  if (
    binding.state === "active" &&
    binding.installedGeneration === binding.desiredGeneration &&
    binding.installedFingerprintSha256 !== null &&
    binding.appliedGeneration === binding.desiredGeneration &&
    binding.inUseAt !== null
  ) {
    return { status: "in_use", phase: null, message: null };
  }
  if (
    binding.installedGeneration === binding.desiredGeneration &&
    binding.installedFingerprintSha256 !== null
  ) {
    return { status: "installed", phase: null, message: null };
  }
  return { status: "pending", phase: null, message: null };
}
