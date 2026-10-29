import type { NewAdminAuditLog } from "@/db/admin-audit-schema";
import { redactString, redactToJson } from "@/orpc/mcp/redact";

// Kept here, not beside the table, so client code can use the values without
// pulling the Drizzle schema into the browser bundle.
export const ADMIN_AUDIT_STATUSES = ["success", "error"] as const;
export type AdminAuditStatus = (typeof ADMIN_AUDIT_STATUSES)[number];

/** A JSON value: what the redactor emits and the jsonb columns hold. */
export type AuditJson =
  | string
  | number
  | boolean
  | null
  | AuditJson[]
  | { [key: string]: AuditJson };

/**
 * Every audited admin action. Names are stable (they are stored and filtered
 * by prefix), dotted `<family>.<verb>` in snake_case. Adding a server function
 * means adding its name here, which `admin-audit.test.ts` enforces.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "user.create",
  "user.update",
  "user.set_password",
  "user.set_role",
  "user.ban",
  "user.unban",
  "user.delete",
  "user.bulk_update",
  "user.send_sign_in_link",
  "user.revoke_session",
  "user.revoke_sessions",
  "user.impersonate",
  "user.note_add",
  "user.note_delete",
  "subscription.create",
  "subscription.update",
  "subscription.delete",
  "subscription.bulk_update",
  "subscription.reset_credentials",
  "subscription.refresh_token",
  "plan.create",
  "plan.update",
  "plan.delete",
  "group.create",
  "group.update",
  "group.delete",
  "node.create",
  "node.update",
  "node.delete",
  "server.create",
  "server.update",
  "server.delete",
  "server.regenerate_token",
  "certificate.create",
  "certificate.import",
  "certificate.delete",
  "certificate.renew",
  "certificate.reconcile",
  "certificate.continue_dns_challenge",
  "certificate.replace_material",
  "certificate.activate_pending",
  "certificate.discard_pending",
  "rule.create",
  "rule.update",
  "rule.delete",
  "rule.reorder",
  "announcement.create",
  "announcement.update",
  "announcement.delete",
  "redeem.batch_create",
  "redeem.codes_add",
  "redeem.batch_update",
  "redeem.code_update",
  "redeem.batch_delete",
  "audit.purge",
  "settings.update",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** Families offered by the audit page's action filter (the dotted prefix). */
export const ADMIN_AUDIT_ACTION_FAMILIES = [
  "user",
  "subscription",
  "plan",
  "group",
  "node",
  "server",
  "certificate",
  "rule",
  "announcement",
  "redeem",
  "audit",
  "settings",
] as const;

export type AdminAuditActionFamily =
  (typeof ADMIN_AUDIT_ACTION_FAMILIES)[number];

export const ADMIN_AUDIT_TARGET_TYPES = [
  "user",
  "user_note",
  "subscription",
  "plan",
  "group",
  "node",
  "server",
  "certificate",
  "rule",
  "announcement",
  "redeem_batch",
  "redeem_code",
  "audit_log",
  "setting",
] as const;

export type AdminAuditTargetType = (typeof ADMIN_AUDIT_TARGET_TYPES)[number];

/** `user.ban` -> `user`. */
export function getActionFamily(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(0, dot);
}

/** What a target resolver can see once the server function has run. */
export interface AuditTargetContext {
  /** Raw client input: validation has not run yet, so treat it as unknown. */
  input: unknown;
  /** The handler's return value; undefined when it threw. */
  result: unknown;
}

export type AuditTargetResolver = (context: AuditTargetContext) => unknown;

export interface AdminAuditMeta {
  targetType?: AdminAuditTargetType;
  /** The affected record's id. Leave unset for bulk operations. */
  targetId?: AuditTargetResolver;
  /** Extra context stored beside the input, e.g. the ids of a bulk update. */
  metadata?: AuditTargetResolver;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Target id read from the (raw) input, e.g. `fromInput("userId")`. */
export function fromInput(...path: string[]): AuditTargetResolver {
  return ({ input }) => readPath(input, path);
}

/** Target id read from the handler result, e.g. `fromResult("server", "id")`. */
export function fromResult(...path: string[]): AuditTargetResolver {
  return ({ result }) => readPath(result, path);
}

/**
 * Metadata of a bulk operation: the targeted ids and, when the handler
 * reports them, how many succeeded / failed / were skipped.
 */
export const bulkMetadata: AuditTargetResolver = ({ input, result }) => {
  const ids = readPath(input, ["ids"]);
  const summary: Record<string, unknown> = {
    ids: Array.isArray(ids) ? ids : [],
  };
  const succeeded = readPath(result, ["succeeded"]);
  if (typeof succeeded === "number") summary.succeeded = succeeded;
  for (const key of ["failed", "skipped"] as const) {
    const value = readPath(result, [key]);
    if (Array.isArray(value)) {
      summary[key] = value.map((entry) =>
        typeof entry === "object" && entry !== null && "id" in entry
          ? (entry as { id: unknown }).id
          : entry,
      );
    }
  }
  return summary;
};

/** Longest id / email / user-agent stored; anything past it is cut. */
const MAX_ID_LENGTH = 200;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_IP_LENGTH = 64;
const MAX_ERROR_LENGTH = 1000;

const INPUT_LIMITS = {
  maxBytes: 8192,
  maxStringLength: 500,
  maxArrayItems: 50,
};
const METADATA_LIMITS = {
  maxBytes: 32768,
  maxStringLength: 500,
  maxArrayItems: 500,
};

/** Input as stored: secrets scrubbed, long strings / arrays / bodies cut. */
export function redactAuditInput(input: unknown): AuditJson {
  return input === undefined
    ? null
    : (redactToJson(input, INPUT_LIMITS) as AuditJson);
}

export function redactAuditMetadata(metadata: unknown): AuditJson {
  return metadata === undefined || metadata === null
    ? null
    : (redactToJson(metadata, METADATA_LIMITS) as AuditJson);
}

/** Error message as stored: secrets scrubbed and cut to length. */
export function redactAuditError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  return redactString(message, MAX_ERROR_LENGTH);
}

function toTargetId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, MAX_ID_LENGTH);
}

/** A resolver may throw on malformed raw input: that must never fail the audit. */
function safeResolve(
  resolver: AuditTargetResolver | undefined,
  context: AuditTargetContext,
): unknown {
  if (!resolver) return undefined;
  try {
    return resolver(context);
  } catch {
    return undefined;
  }
}

export interface BuildAuditRowParams {
  id: string;
  action: AdminAuditAction;
  meta?: AdminAuditMeta;
  input: unknown;
  result?: unknown;
  /** Set when the handler threw. */
  error?: unknown;
  failed: boolean;
  actor: { id: string; email: string | null };
  impersonatedBy?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  durationMs: number;
}

/** Assembles the stored row: resolves the target and redacts everything. */
export function buildAdminAuditRow(
  params: BuildAuditRowParams,
): NewAdminAuditLog {
  const { meta = {}, failed } = params;
  const context: AuditTargetContext = {
    input: params.input,
    result: params.result,
  };
  const status: AdminAuditStatus = failed ? "error" : "success";

  return {
    id: params.id,
    actorUserId: params.actor.id,
    actorEmail: params.actor.email?.slice(0, MAX_ID_LENGTH) ?? null,
    action: params.action,
    targetType: meta.targetType ?? null,
    targetId: toTargetId(safeResolve(meta.targetId, context)),
    status,
    input: redactAuditInput(params.input),
    metadata: redactAuditMetadata(safeResolve(meta.metadata, context)),
    error: failed ? redactAuditError(params.error) : null,
    ip: params.ip?.slice(0, MAX_IP_LENGTH) ?? null,
    userAgent: params.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    impersonatedBy: params.impersonatedBy ?? null,
    durationMs: Math.max(0, Math.round(params.durationMs)),
  };
}
