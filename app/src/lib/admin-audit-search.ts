import { z } from "zod";

import {
  AUDIT_PAGE_SIZES,
  AUDIT_SOURCES,
  type AdminAuditFilterInput,
  type McpAuditFilterInput,
  MCP_AUDIT_STATUSES,
} from "@/orpc/audit/schema";

export const DEFAULT_AUDIT_PAGE_SIZE = 20;

/** A calendar day as typed into `<input type="date">`. */
const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => parseDay(value) !== undefined);

// Numeric-looking text is parsed as a number by the router.
const text = z
  .union([z.string(), z.number()])
  .transform(String)
  .optional()
  .catch(undefined);

/**
 * URL search params of the audit page. Defaults are left out of the URL
 * (undefined), and every field falls back to undefined on garbage input so a
 * hand-edited link never breaks the page. On the MCP tab `action` filters by
 * tool name and the target filters do not apply.
 */
export const auditSearchSchema = z.object({
  tab: z.enum(AUDIT_SOURCES).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((value) => (AUDIT_PAGE_SIZES as readonly number[]).includes(value))
    .optional()
    .catch(undefined),
  actor: text,
  action: text,
  targetType: text,
  targetId: text,
  status: z.enum(MCP_AUDIT_STATUSES).optional().catch(undefined),
  from: dayString.optional().catch(undefined),
  to: dayString.optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export type AuditSearch = z.infer<typeof auditSearchSchema>;

/** Local midnight of a `YYYY-MM-DD` day, or undefined if it is not a real day. */
export function parseDay(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(year, month - 1, day);
  // Rejects overflow like 2026-02-31, which `Date` would roll into March.
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : undefined;
}

/**
 * The instants a day range stands for, in the viewer's time zone: from the
 * start of `from` up to (excluding) the start of the day after `to`.
 */
export function dayRangeToInstants(
  from: string | undefined,
  to: string | undefined,
): { from?: string; to?: string } {
  const start = parseDay(from);
  const endDay = parseDay(to);
  const end = endDay
    ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1)
    : undefined;
  return {
    from: start?.toISOString(),
    to: end?.toISOString(),
  };
}

const clean = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/** The server-side filter the search params stand for on the admin tab. */
export function searchToAdminFilter(
  search: AuditSearch,
): AdminAuditFilterInput {
  return {
    actor: clean(search.actor),
    action: clean(search.action),
    targetType: clean(search.targetType),
    targetId: clean(search.targetId),
    status: search.status === "timeout" ? undefined : search.status,
    ...dayRangeToInstants(search.from, search.to),
    sortDir: search.dir ?? "desc",
  };
}

/** The server-side filter the search params stand for on the MCP tab. */
export function searchToMcpFilter(search: AuditSearch): McpAuditFilterInput {
  return {
    actor: clean(search.actor),
    tool: clean(search.action),
    status: search.status,
    ...dayRangeToInstants(search.from, search.to),
    sortDir: search.dir ?? "desc",
  };
}
