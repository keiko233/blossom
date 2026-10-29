import { createServerFn } from "@tanstack/react-start";
import { count, lt } from "drizzle-orm";

import { db } from "@/db";
import { adminAuditLog } from "@/db/admin-audit-schema";
import { adminAuditToCsv, mcpAuditToCsv } from "@/lib/admin-audit-csv";
import {
  buildAdminAuditOrderBy,
  buildAdminAuditWhere,
} from "@/lib/admin-audit-filters";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  AUDIT_EXPORT_MAX_ROWS,
  adminAuditFilterSchema,
  listAdminAuditSchema,
  listMcpAuditSchema,
  mcpAuditFilterSchema,
  purgeAdminAuditSchema,
} from "@/orpc/audit/schema";
import { countMcpToolAudits, listMcpToolAudits } from "@/query/mcp-audit";

/** TanStack Query key for everything on the admin audit page. */
export const ADMIN_AUDIT_QUERY_KEY = ["admin", "audit"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Filtered, sorted and paginated in SQL; `total` is the unpaged match count. */
export const listAdminAudit = createServerFn({ method: "GET" })
  .validator(listAdminAuditSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { page, pageSize, ...filter } = data;
    const where = buildAdminAuditWhere(filter);

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(adminAuditLog)
        .where(where)
        .orderBy(...buildAdminAuditOrderBy(filter.sortDir))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ value: count() }).from(adminAuditLog).where(where),
    ]);
    return { rows, total: totalRow?.value ?? 0 };
  });

export type AdminAuditEntry = Awaited<
  ReturnType<typeof listAdminAudit>
>["rows"][number];

/** Read-only MCP tool calls, paginated for the audit page's MCP tab. */
export const listMcpAudit = createServerFn({ method: "GET" })
  .validator(listMcpAuditSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { page, pageSize, ...filter } = data;
    const [rows, total] = await Promise.all([
      listMcpToolAudits({
        filter,
        order: filter.sortDir,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      countMcpToolAudits({ filter }),
    ]);
    return { rows, total };
  });

export type McpAuditEntry = Awaited<
  ReturnType<typeof listMcpAudit>
>["rows"][number];

/**
 * CSV of every admin audit entry matching the filters (not just one page),
 * capped at AUDIT_EXPORT_MAX_ROWS; `truncated` tells the caller the cap hit.
 */
export const exportAdminAuditCsv = createServerFn({ method: "GET" })
  .validator(adminAuditFilterSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(buildAdminAuditWhere(data))
      .orderBy(...buildAdminAuditOrderBy(data.sortDir))
      .limit(AUDIT_EXPORT_MAX_ROWS + 1);
    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const exported = truncated ? rows.slice(0, AUDIT_EXPORT_MAX_ROWS) : rows;
    return {
      csv: adminAuditToCsv(exported),
      count: exported.length,
      truncated,
    };
  });

/** Same as above for the MCP tool audit tab. */
export const exportMcpAuditCsv = createServerFn({ method: "GET" })
  .validator(mcpAuditFilterSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const rows = await listMcpToolAudits({
      filter: data,
      order: data.sortDir,
      limit: AUDIT_EXPORT_MAX_ROWS + 1,
    });
    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const exported = truncated ? rows.slice(0, AUDIT_EXPORT_MAX_ROWS) : rows;
    return {
      csv: mcpAuditToCsv(exported),
      count: exported.length,
      truncated,
    };
  });

/**
 * Retention: deletes admin audit entries older than the given number of days.
 * The purge itself is audited, and its own entry is written after the delete,
 * so it always survives.
 */
export const purgeAdminAudit = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("audit.purge", {
      targetType: "audit_log",
      metadata: ({ result }) => result,
    }),
  ])
  .validator(purgeAdminAuditSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const cutoff = new Date(Date.now() - data.olderThanDays * MS_PER_DAY);
    const where = lt(adminAuditLog.createdAt, cutoff);

    const [matching] = await db
      .select({ value: count() })
      .from(adminAuditLog)
      .where(where);
    await db.delete(adminAuditLog).where(where);
    return { deleted: matching?.value ?? 0, cutoff: cutoff.toISOString() };
  });
