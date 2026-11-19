import {
  isLogPolicyTemporaryLevel,
  type LogPolicySource,
} from "@blossom/contracts/log-policy";
import { createServerFn } from "@tanstack/react-start";

import { fromInput, type AuditTargetContext } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { notifyAgentLogPolicyChanged } from "@/lib/agent-notifications";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  readServerLogPolicy,
  restoreServerLogPolicy,
  resolveLogPolicyDeadline,
  serverLogPolicyReadSchema,
  serverLogPolicyResetSchema,
  serverLogPolicyWriteSchema,
  writeServerLogPolicy,
  type ServerLogPolicyMutationResult,
  type ServerLogPolicyView,
} from "@/query/log-policy";

function sourceOf(context: AuditTargetContext): LogPolicySource | undefined {
  const source = (context.input as { source?: unknown } | undefined)?.source;
  return source === "agent" || source === "sing-box" ? source : undefined;
}

function auditMetadata(context: AuditTargetContext) {
  const result = context.result as ServerLogPolicyMutationResult | undefined;
  if (!result) return undefined;
  const source = sourceOf(context);
  if (!result.ok) {
    return {
      outcome: result.reason,
      source,
      current: source ? result.policy?.sources[source] : result.policy,
    };
  }
  return {
    outcome: "applied",
    source: result.next.source,
    previous: result.previous,
    next: result.next,
  };
}

async function requirePolicy(serverId: string): Promise<ServerLogPolicyView> {
  const policy = await readServerLogPolicy(serverId);
  if (!policy) {
    throw new Error("Not found");
  }
  return policy;
}

/**
 * Admin read. Audited like the mutations because the response carries the
 * requested and effective levels for a specific host.
 */
export const getServerLogPolicy = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.log_policy_read", {
      targetType: "server",
      targetId: fromInput("serverId"),
    }),
  ])
  .validator(serverLogPolicyReadSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return requirePolicy(data.serverId);
  });

/**
 * Stores one source's desired level and its bounded expiry. `expectedRevision`
 * is the server-wide revision the UI last saw; a stale value is a conflict.
 */
export const updateServerLogPolicy = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.log_policy_write", {
      targetType: "server",
      targetId: fromInput("serverId"),
      metadata: auditMetadata,
    }),
  ])
  .validator(serverLogPolicyWriteSchema)
  .handler(async ({ data }): Promise<ServerLogPolicyMutationResult> => {
    const session = await ensureAdmin();
    const before = await requirePolicy(data.serverId);
    const deadline = resolveLogPolicyDeadline(
      data.level,
      data.temporarySeconds,
    );
    // A temporary level changes only the override; the configured baseline
    // stays until the admin explicitly replaces or clears it.
    const baseline = isLogPolicyTemporaryLevel(data.level)
      ? before.sources[data.source].desiredBaseline
      : data.level;
    const written = await writeServerLogPolicy({
      serverId: data.serverId,
      source: data.source,
      baseline,
      level: data.level,
      deadline,
      actorId: session.user.id,
      expectedRevision: data.expectedRevision,
    });
    if (!written) {
      return {
        ok: false,
        reason: "conflict",
        policy: await readServerLogPolicy(data.serverId),
      };
    }
    const policy = await requirePolicy(data.serverId);
    await notifyAgentLogPolicyChanged(
      data.serverId,
      written.revision,
      data.source,
    );
    return {
      ok: true,
      policy,
      previous: before.sources[data.source],
      next: policy.sources[data.source],
    };
  });

/**
 * Restore now clears the temporary override and keeps the configured baseline.
 * `mode: "restore-default"` also clears the configured baseline, returning to
 * the agent's installed or generated default. The two are distinct actions.
 */
export const resetServerLogPolicy = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("server.log_policy_reset", {
      targetType: "server",
      targetId: fromInput("serverId"),
      metadata: auditMetadata,
    }),
  ])
  .validator(serverLogPolicyResetSchema)
  .handler(async ({ data }): Promise<ServerLogPolicyMutationResult> => {
    const session = await ensureAdmin();
    const before = await requirePolicy(data.serverId);
    const written = await restoreServerLogPolicy({
      serverId: data.serverId,
      source: data.source,
      mode: data.mode,
      actorId: session.user.id,
      expectedRevision: data.expectedRevision,
    });
    if (!written) {
      return {
        ok: false,
        reason: "conflict",
        policy: await readServerLogPolicy(data.serverId),
      };
    }
    const policy = await requirePolicy(data.serverId);
    await notifyAgentLogPolicyChanged(
      data.serverId,
      written.revision,
      data.source,
    );
    return {
      ok: true,
      policy,
      previous: before.sources[data.source],
      next: policy.sources[data.source],
    };
  });
