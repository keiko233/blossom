import { z } from "zod";

import { ADMIN_AUDIT_STATUSES } from "@/lib/admin-audit";

/**
 * Admin audit log input schemas, shared by the list, the CSV export and the
 * URL search params of the audit page.
 */

export const AUDIT_PAGE_SIZES = [20, 50, 100] as const;

/** Hard cap on rows a CSV export returns. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

export const AUDIT_SOURCES = ["admin", "mcp"] as const;
export const auditSourceSchema = z.enum(AUDIT_SOURCES);

export const MCP_AUDIT_STATUSES = ["success", "error", "timeout"] as const;

export const auditSortDirSchema = z.enum(["asc", "desc"]);

/** Retention bounds for the purge, in days. */
export const AUDIT_RETENTION_DEFAULT_DAYS = 180;
export const AUDIT_RETENTION_MIN_DAYS = 1;
export const AUDIT_RETENTION_MAX_DAYS = 3650;

const isoInstant = z.iso.datetime();

/** Filters of the admin audit list and export. */
export const adminAuditFilterSchema = z.object({
  // Substring of the actor's email (snapshotted) or the exact actor user id.
  actor: z.string().trim().max(200).optional(),
  // Dotted action prefix: `user.` for a family, `user.ban` for one action.
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(50).optional(),
  targetId: z.string().trim().max(200).optional(),
  status: z.enum(ADMIN_AUDIT_STATUSES).optional(),
  // ISO instants: `from` inclusive, `to` exclusive.
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  sortDir: auditSortDirSchema.default("desc"),
});

export const listAdminAuditSchema = adminAuditFilterSchema.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

/** Filters of the read-only MCP tool audit tab. */
export const mcpAuditFilterSchema = z.object({
  actor: z.string().trim().max(200).optional(),
  // Tool name prefix.
  tool: z.string().trim().max(100).optional(),
  status: z.enum(MCP_AUDIT_STATUSES).optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  sortDir: auditSortDirSchema.default("desc"),
});

export const listMcpAuditSchema = mcpAuditFilterSchema.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export const purgeAdminAuditSchema = z.object({
  olderThanDays: z
    .number()
    .int()
    .min(AUDIT_RETENTION_MIN_DAYS)
    .max(AUDIT_RETENTION_MAX_DAYS),
});

export type AdminAuditFilter = z.infer<typeof adminAuditFilterSchema>;
export type AdminAuditFilterInput = z.input<typeof adminAuditFilterSchema>;
export type ListAdminAuditInput = z.input<typeof listAdminAuditSchema>;
export type McpAuditFilter = z.infer<typeof mcpAuditFilterSchema>;
export type McpAuditFilterInput = z.input<typeof mcpAuditFilterSchema>;
export type ListMcpAuditInput = z.input<typeof listMcpAuditSchema>;
export type AuditSource = z.infer<typeof auditSourceSchema>;
