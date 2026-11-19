import { z } from "zod";

/**
 * The `log-policy-v1` capability and its v2 message payloads.
 *
 * Log policy is deliberately separate from the configuration identifier and
 * the publish gate: a logging-only edit carries its own revision, never moves
 * `desiredRevisionSeq`, and never changes the compiled configuration digest.
 *
 * The control plane stores one desired row per server and source. A snapshot
 * describes only the state the agent must apply; effective status travels
 * back in `log.policy.ack` and contains no log lines.
 */
export const LOG_POLICY_CAPABILITY = "log-policy-v1" as const;

export const LOG_POLICY_SOURCES = ["agent", "sing-box"] as const;
export const LOG_POLICY_LEVELS = [
  "default",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;
export const LOG_POLICY_BASELINE_LEVELS = [
  "default",
  "error",
  "warn",
  "info",
] as const;
export const LOG_POLICY_TEMPORARY_LEVELS = ["debug", "trace"] as const;

/** Proposed temporary override lifetime when the admin does not choose one. */
export const LOG_POLICY_DEFAULT_TEMPORARY_SECONDS = 15 * 60;
/** Hard maximum for a temporary override. */
export const LOG_POLICY_MAX_TEMPORARY_SECONDS = 60 * 60;
/** Bound on an agent-reported application error. */
export const LOG_POLICY_MAX_ERROR_CHARS = 512;

export const logPolicySourceSchema = z.enum(LOG_POLICY_SOURCES);
export const logPolicyLevelSchema = z.enum(LOG_POLICY_LEVELS);
export const logPolicyBaselineLevelSchema = z.enum(LOG_POLICY_BASELINE_LEVELS);
export const logPolicyTemporaryLevelSchema = z.enum(
  LOG_POLICY_TEMPORARY_LEVELS,
);

export type LogPolicySource = z.infer<typeof logPolicySourceSchema>;
export type LogPolicyLevel = z.infer<typeof logPolicyLevelSchema>;
export type LogPolicyBaselineLevel = z.infer<
  typeof logPolicyBaselineLevelSchema
>;
export type LogPolicyTemporaryLevel = z.infer<
  typeof logPolicyTemporaryLevelSchema
>;

/** RFC3339 with an explicit UTC designator or offset, as chrono emits. */
const timestampSchema = z.iso.datetime({ offset: true });

export function isLogPolicyTemporaryLevel(
  level: LogPolicyLevel,
): level is LogPolicyTemporaryLevel {
  return level === "debug" || level === "trace";
}

/**
 * One source of a `log.policy.snapshot`. `revision` is scoped to that source
 * and increases only when that source's desired state changes. A temporary
 * level always carries its absolute deadline; a baseline level never does.
 */
export const logPolicyDesiredSourceSchema = z
  .object({
    source: logPolicySourceSchema,
    revision: z.number().int().min(0),
    level: logPolicyLevelSchema,
    deadline: timestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    const temporary = isLogPolicyTemporaryLevel(value.level);
    if (temporary && value.deadline === null) {
      context.addIssue({
        code: "custom",
        message: "debug and trace require an override deadline",
        path: ["deadline"],
      });
    }
    if (!temporary && value.deadline !== null) {
      context.addIssue({
        code: "custom",
        message: "a baseline level cannot carry an override deadline",
        path: ["deadline"],
      });
    }
  });

export type LogPolicyDesiredSource = z.infer<
  typeof logPolicyDesiredSourceSchema
>;

/** `log.policy.notify` (control plane to agent): a hint to fetch a snapshot. */
export const logPolicyNotifyPayloadSchema = z.object({
  revision: z.number().int().min(0),
  source: logPolicySourceSchema.optional(),
  reason: z.string().min(1).max(256).optional(),
});

export type LogPolicyNotifyPayload = z.infer<
  typeof logPolicyNotifyPayloadSchema
>;

/** `log.policy.get` (agent to control plane). */
export const logPolicyGetPayloadSchema = z.object({
  requestId: z.string().min(1).max(128),
});

export type LogPolicyGetPayload = z.infer<typeof logPolicyGetPayloadSchema>;

/**
 * `log.policy.snapshot` (control plane to agent). `revision` is the
 * server-wide policy revision used for welcome/status reconciliation; each
 * source also carries its own revision for idempotent application.
 */
export const logPolicySnapshotPayloadSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    revision: z.number().int().min(0),
    sources: z.array(logPolicyDesiredSourceSchema).min(1).max(2),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const source of value.sources) {
      if (seen.has(source.source)) {
        context.addIssue({
          code: "custom",
          message: "a snapshot names each source at most once",
          path: ["sources"],
        });
      }
      seen.add(source.source);
    }
  });

export type LogPolicySnapshotPayload = z.infer<
  typeof logPolicySnapshotPayloadSchema
>;

/**
 * `log.policy.ack` (agent to control plane). It reports the requested and
 * effective levels, the baseline, the expiry and the bounded apply error. It
 * never contains log lines or configuration bodies.
 */
export const logPolicyAckPayloadSchema = z
  .object({
    source: logPolicySourceSchema,
    sourceRevision: z.number().int().min(0),
    requested: logPolicyLevelSchema,
    baseline: logPolicyLevelSchema,
    effective: logPolicyLevelSchema,
    deadline: timestampSchema.nullable(),
    error: z.string().min(1).max(LOG_POLICY_MAX_ERROR_CHARS).nullable(),
    pending: z.boolean(),
  })
  .superRefine((value, context) => {
    const temporary = isLogPolicyTemporaryLevel(value.requested);
    if (temporary && value.deadline === null) {
      context.addIssue({
        code: "custom",
        message: "a temporary request always carries its deadline",
        path: ["deadline"],
      });
    }
    if (!temporary && value.deadline !== null) {
      context.addIssue({
        code: "custom",
        message: "a baseline request carries no deadline",
        path: ["deadline"],
      });
    }
  });

export type LogPolicyAckPayload = z.infer<typeof logPolicyAckPayloadSchema>;
