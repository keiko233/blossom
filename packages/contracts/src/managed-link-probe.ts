import { z } from "zod";

/**
 * Bounded link-probe correlation contract (Task 08: rollout and link probe).
 *
 * The control plane asks the source agent to probe one planned link through an
 * agent-owned loopback ingress into the managed peer outbound, against a fixed
 * agent-owned responder on the destination. The request names identifiers and
 * generations only: the agent derives the outbound tag from `linkId` and keeps
 * endpoints local. The result carries a bounded outcome and no free-form error
 * text, so nothing unsanitized reaches the control plane or browser.
 *
 * These payloads are not yet registered in the v2 message tables or the
 * OpenAPI surface; that wiring is gated on the capability below.
 */

export const MANAGED_LINK_PROBE_CAPABILITY = "managed-link-probe-v1" as const;

/** Proposed v2 message types (control plane -> agent, agent -> control plane). */
export const MANAGED_LINK_PROBE_MESSAGE_TYPES = {
  request: "link_probe.request",
  result: "link_probe.result",
} as const;

export const MANAGED_LINK_PROBE_LIMITS = {
  maxTtlMs: 120_000,
  maxLatencyMs: 60_000,
} as const;

export const MANAGED_LINK_PROBE_OUTCOMES = [
  "succeeded",
  "timeout",
  "connect_failed",
  "tls_failed",
  "auth_rejected",
  "responder_mismatch",
  "generation_mismatch",
  "expired",
  "isolation_unavailable",
  "unsupported",
] as const;
export type ManagedLinkProbeOutcome =
  (typeof MANAGED_LINK_PROBE_OUTCOMES)[number];

const idSchema = z.string().min(1).max(128);
const fingerprintSchema = z.string().min(1).max(128);
const timestampSchema = z.iso.datetime();

/** Applied generation a probe is bound to on one side of the link. */
export const managedLinkProbeEndpointSchema = z.object({
  serverId: idSchema,
  managedFingerprint: fingerprintSchema,
  minRevisionSeq: z.number().int().min(0),
});
export type ManagedLinkProbeEndpoint = z.infer<
  typeof managedLinkProbeEndpointSchema
>;

export const managedLinkProbeRequestSchema = z
  .object({
    probeId: idSchema,
    rolloutId: idSchema,
    stageOrdinal: z.number().int().min(1),
    linkId: idSchema,
    credentialGeneration: z.number().int().min(1),
    source: managedLinkProbeEndpointSchema,
    destination: managedLinkProbeEndpointSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .superRefine((value, context) => {
    const ttl = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (!(ttl > 0 && ttl <= MANAGED_LINK_PROBE_LIMITS.maxTtlMs)) {
      context.addIssue({
        code: "custom",
        message: `probe lifetime must be within (0, ${MANAGED_LINK_PROBE_LIMITS.maxTtlMs}] ms`,
        path: ["expiresAt"],
      });
    }
    if (value.source.serverId === value.destination.serverId) {
      context.addIssue({
        code: "custom",
        message: "a link probe cannot target its own server",
        path: ["destination", "serverId"],
      });
    }
  });
export type ManagedLinkProbeRequest = z.infer<
  typeof managedLinkProbeRequestSchema
>;

export const managedLinkProbeResultSchema = z.object({
  probeId: idSchema,
  rolloutId: idSchema,
  stageOrdinal: z.number().int().min(1),
  linkId: idSchema,
  outcome: z.enum(MANAGED_LINK_PROBE_OUTCOMES),
  /** What the source agent had committed when it ran the probe. */
  applied: z.object({
    desiredRevisionSeq: z.number().int().min(0),
    managedFingerprint: fingerprintSchema.nullable(),
  }),
  latencyMs: z
    .number()
    .int()
    .min(0)
    .max(MANAGED_LINK_PROBE_LIMITS.maxLatencyMs)
    .optional(),
  completedAt: timestampSchema,
});
export type ManagedLinkProbeResult = z.infer<
  typeof managedLinkProbeResultSchema
>;

export type LinkProbeCorrelation =
  | { kind: "record"; outcome: ManagedLinkProbeOutcome }
  | { kind: "duplicate" }
  | { kind: "reject"; reason: LinkProbeRejectReason };

export type LinkProbeRejectReason =
  | "wrong_server"
  | "superseded_probe"
  | "correlation_mismatch"
  | "expired"
  | "stale_generation"
  | "conflicting_result";

/**
 * Correlates one authenticated result with the persisted request. Only the
 * source server's session may answer, only for the probe that is still current
 * for its stage attempt, before expiry, and bound to the generation the
 * request named. Recording is idempotent per probe.
 *
 * @param currentProbeId the latest probe issued for the stage; an older probe
 *   was invalidated by a retry or a re-issued attempt.
 * @param recordedOutcome the outcome already persisted for this probe, if any.
 */
export function correlateLinkProbeResult(input: {
  request: ManagedLinkProbeRequest;
  currentProbeId: string;
  authenticatedServerId: string;
  result: ManagedLinkProbeResult;
  receivedAt: Date;
  recordedOutcome: ManagedLinkProbeOutcome | null;
}): LinkProbeCorrelation {
  const { request, result } = input;
  if (input.authenticatedServerId !== request.source.serverId) {
    return { kind: "reject", reason: "wrong_server" };
  }
  if (
    result.probeId !== request.probeId ||
    result.rolloutId !== request.rolloutId ||
    result.stageOrdinal !== request.stageOrdinal ||
    result.linkId !== request.linkId
  ) {
    return { kind: "reject", reason: "correlation_mismatch" };
  }
  if (request.probeId !== input.currentProbeId) {
    return { kind: "reject", reason: "superseded_probe" };
  }
  if (input.recordedOutcome !== null) {
    return input.recordedOutcome === result.outcome
      ? { kind: "duplicate" }
      : { kind: "reject", reason: "conflicting_result" };
  }
  if (input.receivedAt.getTime() > Date.parse(request.expiresAt)) {
    return { kind: "reject", reason: "expired" };
  }
  if (
    result.outcome === "succeeded" &&
    (result.applied.desiredRevisionSeq < request.source.minRevisionSeq ||
      result.applied.managedFingerprint !== request.source.managedFingerprint)
  ) {
    return { kind: "reject", reason: "stale_generation" };
  }
  return { kind: "record", outcome: result.outcome };
}

/** Both ends must advertise the capability before a probe can be issued. */
export function supportsLinkProbe(
  sourceCapabilities: readonly string[],
  destinationCapabilities: readonly string[],
): boolean {
  return (
    sourceCapabilities.includes(MANAGED_LINK_PROBE_CAPABILITY) &&
    destinationCapabilities.includes(MANAGED_LINK_PROBE_CAPABILITY)
  );
}
