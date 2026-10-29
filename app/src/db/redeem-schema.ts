import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { RedeemMode } from "@/lib/redeem-batch";

import { user } from "./auth-schema";
import { plan, subscription } from "./plan-schema";

/**
 * A batch of redeem codes that all grant the same plan without payment.
 *
 * `planId` is `restrict`: a plan that backs a batch cannot be deleted, so
 * issued codes never silently turn into nothing (delete or empty the batch
 * first). `durationDays` null means the plan's own duration. `mode`:
 * `new` always creates a subscription; `extend` renews the user's active
 * subscription on the same plan (expiry out by the duration, quota topped up
 * by one plan allowance) and creates one only when there is none.
 */
export const redeemBatch = pgTable(
  "redeem_batch",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    durationDays: integer("duration_days"),
    mode: text("mode").$type<RedeemMode>().default("new").notNull(),
    // Uses one code allows (1 = one-time code).
    maxRedemptionsPerCode: integer("max_redemptions_per_code")
      .default(1)
      .notNull(),
    // Codes from this batch one user may redeem in total.
    perUserLimit: integer("per_user_limit").default(1).notNull(),
    // Codes stop working at this instant; null = never.
    expiresAt: timestamp("expires_at"),
    disabled: boolean("disabled").default(false).notNull(),
    note: text("note"),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("redeem_batch_plan_idx").on(table.planId),
    index("redeem_batch_created_idx").on(table.createdAt),
  ],
);

/**
 * One redeem code. Only the SHA-256 of the normalized code is stored; the
 * plaintext exists once, in the response that generated it. `prefix` is the
 * first few characters, for display and admin search.
 */
export const redeemCode = pgTable(
  "redeem_code",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => redeemBatch.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    prefix: text("prefix").notNull(),
    redemptionCount: integer("redemption_count").default(0).notNull(),
    disabled: boolean("disabled").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("redeem_code_hash_idx").on(table.codeHash),
    index("redeem_code_batch_idx").on(table.batchId, table.createdAt),
  ],
);

/**
 * A use of a code by a user. (code, user) is unique so the same user can never
 * redeem the same code twice, even under concurrent requests. Deleting the
 * subscription keeps the redemption (the grant stays in the history).
 */
export const redeemRedemption = pgTable(
  "redeem_redemption",
  {
    id: text("id").primaryKey(),
    codeId: text("code_id")
      .notNull()
      .references(() => redeemCode.id, { onDelete: "cascade" }),
    // Denormalized from the code so per-user-per-batch counts need no join.
    batchId: text("batch_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").references(() => subscription.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("redeem_redemption_code_user_idx").on(
      table.codeId,
      table.userId,
    ),
    index("redeem_redemption_batch_idx").on(table.batchId, table.createdAt),
    index("redeem_redemption_user_idx").on(table.userId, table.batchId),
  ],
);

/**
 * A redeem attempt that has not (yet) succeeded, for brute-force throttling.
 * Recorded before a code is checked and deleted again when the attempt turns
 * out not to be a failed guess; whatever remains is counted per user and per
 * IP over a sliding window (see `@/lib/redeem-throttle`). Old rows are pruned
 * opportunistically.
 */
export const redeemAttempt = pgTable(
  "redeem_attempt",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ip: text("ip"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("redeem_attempt_user_idx").on(table.userId, table.createdAt),
    index("redeem_attempt_ip_idx").on(table.ip, table.createdAt),
  ],
);

export type RedeemBatch = typeof redeemBatch.$inferSelect;
export type NewRedeemBatch = typeof redeemBatch.$inferInsert;
export type RedeemCode = typeof redeemCode.$inferSelect;
export type NewRedeemCode = typeof redeemCode.$inferInsert;
export type RedeemRedemption = typeof redeemRedemption.$inferSelect;
export type NewRedeemRedemption = typeof redeemRedemption.$inferInsert;
