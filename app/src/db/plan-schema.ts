import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema.ts";
import { proxyGroup } from "./proxy-schema.ts";

/**
 * A plan is a purchasable package granting access to one or more proxy groups
 * (via `plan_group`). Prices are stored in cents and traffic in bytes; the UI
 * converts to display units.
 */
export const plan = pgTable("plan", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull(),
  durationDays: integer("duration_days").notNull(),
  // bigint mode "number" is safe up to 2^53 bytes (~9 PB).
  trafficBytes: bigint("traffic_bytes", { mode: "number" }).notNull(),
  // 0 means unlimited devices.
  deviceLimit: integer("device_limit").default(0).notNull(),
  // Whether the plan is on sale / visible to users.
  visible: boolean("visible").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

/** Plan <-> proxy group binding (many-to-many). */
export const planGroup = pgTable(
  "plan_group",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => proxyGroup.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.groupId] }),
    index("plan_group_group_idx").on(table.groupId),
  ],
);

export type SubscriptionStatus = "active" | "expired" | "cancelled";

/**
 * A user's purchased plan. Quota and device limit are snapshotted at purchase
 * time so later plan edits do not affect existing subscriptions. Multiple
 * active subscriptions stack: the user's accessible nodes are the union across
 * all of them (see `getUserAccessibleNodes` in `@/query/subscription-access`).
 */
export const subscription = pgTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Restrict: plans with subscriptions must not be deleted (also enforced in
    // the deletePlan server function).
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    status: text("status")
      .$type<SubscriptionStatus>()
      .default("active")
      .notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    trafficQuotaBytes: bigint("traffic_quota_bytes", {
      mode: "number",
    }).notNull(),
    trafficUsedBytes: bigint("traffic_used_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    deviceLimit: integer("device_limit").notNull(),

    // Per-subscription proxy credentials, embedded as sing-box inbound users.
    // For `name`-keyed protocols the inbound user name now carries the coded
    // (node, subscription) identifier (see `traffic-user-codec`) so traffic
    // reports still map 1:1 to a subscription and a node; for username-keyed
    // protocols the bare subscription id is used and per-node attribution is
    // lost — those protocols are invisible to v2ray_api user stats regardless.
    // Stored in plaintext by design: sing-box needs the raw secret (contrast
    // `server.agentTokenHash`, which only ever stores a hash).
    credentialUuid: text("credential_uuid").notNull().unique(),
    credentialPassword: text("credential_password").notNull(),

    // Opaque subscription-link token: knowing it grants the compiled Clash config,
    // so it is rotatable independently of the proxy credentials.
    token: text("token").notNull().unique(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("subscription_user_idx").on(table.userId),
    // Drives the accessible-nodes query: active subs for a user not yet expired.
    index("subscription_user_active_idx").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    index("subscription_plan_idx").on(table.planId),
  ],
);

export type Plan = typeof plan.$inferSelect;
export type NewPlan = typeof plan.$inferInsert;
export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
