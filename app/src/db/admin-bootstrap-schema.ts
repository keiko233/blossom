import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The one-time "first registered user becomes administrator" claim. At most
 * one row can exist (`id` is always `true`). The row is inserted by the
 * `user_claim_first_admin` trigger (a custom migration, see
 * `app/drizzle/*_first_admin_trigger`) in the same statement that inserts the
 * first user, and by that migration for databases that already have users.
 *
 * It deliberately has no foreign key to `user`: deleting every user must not
 * reopen the claim, so a later registrant is never promoted.
 */
export const adminBootstrap = pgTable(
  "admin_bootstrap",
  {
    id: boolean("id").primaryKey().default(true),
    /** The user that won the claim; null when an upgrade pre-claimed it. */
    claimedUserId: text("claimed_user_id"),
    claimedAt: timestamp("claimed_at").defaultNow().notNull(),
  },
  (table) => [check("admin_bootstrap_singleton", sql`${table.id} = true`)],
);
