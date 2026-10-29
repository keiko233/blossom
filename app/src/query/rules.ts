import { createServerFn } from "@tanstack/react-start";
import { asc, eq, inArray, max, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { routingRule } from "@/db/rule-schema";
import { bulkMetadata, fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createRuleSchema,
  getRuleIssues,
  reorderRulesSchema,
  ruleIdSchema,
  updateRuleSchema,
} from "@/orpc/rule/schema";

/** TanStack Query key for the admin routing rule list. */
export const RULES_QUERY_KEY = ["admin", "rules"] as const;

// Rule edits need no `recordConfigChange`: server-side rules ride the agent
// config's content hash (the whole compiled sing-box config, `route` included,
// is hashed into the desired revision), and client-side rules only change the
// Clash subscription payload, which has no agent-side state to gate.

export const listRules = createServerFn({ method: "GET" }).handler(async () => {
  await ensureAdmin();
  return db
    .select()
    .from(routingRule)
    .orderBy(
      asc(routingRule.sortOrder),
      asc(routingRule.createdAt),
      asc(routingRule.id),
    );
});

export type RuleListItem = Awaited<ReturnType<typeof listRules>>[number];

export const createRule = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("rule.create", {
      targetType: "rule",
      targetId: fromResult("id"),
    }),
  ])
  .validator(createRuleSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    // New rules append after the existing ones unless an order is given.
    let sortOrder = data.sortOrder;
    if (sortOrder === undefined) {
      const [last] = await db
        .select({ value: max(routingRule.sortOrder) })
        .from(routingRule);
      sortOrder = (last?.value ?? -1) + 1;
    }

    const [row] = await db
      .insert(routingRule)
      .values({ id: randomUUID(), ...data, sortOrder })
      .returning();
    return row;
  });

export const updateRule = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("rule.update", {
      targetType: "rule",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateRuleSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, ...fields } = data;

    const [existing] = await db
      .select()
      .from(routingRule)
      .where(eq(routingRule.id, id));
    if (!existing) {
      throw new Error("Not found");
    }

    // The schema only checks fields that were submitted together; re-check the
    // merged row so e.g. a scope-only change cannot leave a server-side rule
    // with a non-reject action.
    const issues = getRuleIssues({ ...existing, ...fields });
    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.message).join("; "));
    }

    const [row] = await db
      .update(routingRule)
      .set(fields)
      .where(eq(routingRule.id, id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

export const deleteRule = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("rule.delete", {
      targetType: "rule",
      targetId: fromInput("id"),
    }),
  ])
  .validator(ruleIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .delete(routingRule)
      .where(eq(routingRule.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

/**
 * Rewrites `sortOrder` to each id's position in the list. A single CASE
 * statement keeps the reorder atomic on neon-http (no interactive
 * transactions). Rules not in the list keep their order value.
 */
export const reorderRules = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("rule.reorder", { targetType: "rule", metadata: bulkMetadata }),
  ])
  .validator(reorderRulesSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const cases = data.ids.map(
      (id, index) => sql`WHEN ${id} THEN ${index}::integer`,
    );
    await db
      .update(routingRule)
      .set({
        sortOrder: sql`CASE ${routingRule.id} ${sql.join(cases, sql` `)} END`,
      })
      .where(inArray(routingRule.id, data.ids));
    return { count: data.ids.length };
  });
