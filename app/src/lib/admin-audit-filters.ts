import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { adminAuditLog } from "@/db/admin-audit-schema";
import { user } from "@/db/auth-schema";
import { mcpToolAudit } from "@/db/mcp-schema";
import { escapeLikePattern } from "@/lib/subscription-filters";
import type { AdminAuditFilter, McpAuditFilter } from "@/orpc/audit/schema";

/** Time window shared by both audit sources: `from` inclusive, `to` exclusive. */
function timeRange(
  column: typeof adminAuditLog.createdAt | typeof mcpToolAudit.createdAt,
  filter: { from?: string; to?: string },
): SQL[] {
  const conditions: SQL[] = [];
  if (filter.from) conditions.push(gte(column, new Date(filter.from)));
  if (filter.to) conditions.push(lt(column, new Date(filter.to)));
  return conditions;
}

/**
 * WHERE conditions for the admin audit list/export, ANDed by the caller.
 *
 * `targetId` also matches bulk entries that carry the id in `metadata.ids`,
 * so a user's activity includes bulk operations that touched them.
 */
export function buildAdminAuditConditions(filter: AdminAuditFilter): SQL[] {
  const conditions: SQL[] = [];

  const actor = filter.actor?.trim();
  if (actor) {
    const match = or(
      ilike(adminAuditLog.actorEmail, `%${escapeLikePattern(actor)}%`),
      eq(adminAuditLog.actorUserId, actor),
    );
    if (match) conditions.push(match);
  }

  const action = filter.action?.trim();
  if (action) {
    conditions.push(
      ilike(adminAuditLog.action, `${escapeLikePattern(action)}%`),
    );
  }

  if (filter.targetType) {
    conditions.push(eq(adminAuditLog.targetType, filter.targetType));
  }

  const targetId = filter.targetId?.trim();
  if (targetId) {
    const match = or(
      eq(adminAuditLog.targetId, targetId),
      sql`${adminAuditLog.metadata} @> ${JSON.stringify({ ids: [targetId] })}::jsonb`,
    );
    if (match) conditions.push(match);
  }

  if (filter.status) {
    conditions.push(eq(adminAuditLog.status, filter.status));
  }

  conditions.push(...timeRange(adminAuditLog.createdAt, filter));
  return conditions;
}

export function buildAdminAuditWhere(
  filter: AdminAuditFilter,
): SQL | undefined {
  const conditions = buildAdminAuditConditions(filter);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Newest first by default; the id is a tiebreaker so pages never overlap. */
export function buildAdminAuditOrderBy(
  dir: AdminAuditFilter["sortDir"],
): SQL[] {
  const direction = dir === "asc" ? asc : desc;
  return [direction(adminAuditLog.createdAt), direction(adminAuditLog.id)];
}

/**
 * WHERE conditions for the MCP tool audit tab. The actor is matched against
 * the joined user's email or name (the audit row only keeps the user id).
 */
export function buildMcpAuditConditions(filter: McpAuditFilter): SQL[] {
  const conditions: SQL[] = [];

  const actor = filter.actor?.trim();
  if (actor) {
    const pattern = `%${escapeLikePattern(actor)}%`;
    const match = or(
      ilike(user.email, pattern),
      ilike(user.name, pattern),
      eq(mcpToolAudit.actorUserId, actor),
    );
    if (match) conditions.push(match);
  }

  const tool = filter.tool?.trim();
  if (tool) {
    conditions.push(ilike(mcpToolAudit.tool, `${escapeLikePattern(tool)}%`));
  }

  if (filter.status) {
    conditions.push(eq(mcpToolAudit.status, filter.status));
  }

  conditions.push(...timeRange(mcpToolAudit.createdAt, filter));
  return conditions;
}

export function buildMcpAuditWhere(filter: McpAuditFilter): SQL | undefined {
  const conditions = buildMcpAuditConditions(filter);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export function buildMcpAuditOrderBy(dir: McpAuditFilter["sortDir"]): SQL[] {
  const direction = dir === "asc" ? asc : desc;
  return [direction(mcpToolAudit.createdAt), direction(mcpToolAudit.id)];
}
