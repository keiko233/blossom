import { asc, eq } from "drizzle-orm";

import { type Database, db } from "@/db";
import { routingRule } from "@/db/rule-schema";

/**
 * Enabled routing rules in evaluation order, for the compilers (subscription
 * endpoint, agent config). Kept apart from the admin server functions so the
 * server-only `db` import never reaches the client bundle through them.
 */
export async function listEnabledRules(database: Database = db) {
  return database
    .select()
    .from(routingRule)
    .where(eq(routingRule.enabled, true))
    .orderBy(
      asc(routingRule.sortOrder),
      asc(routingRule.createdAt),
      asc(routingRule.id),
    );
}
