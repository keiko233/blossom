import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const RULE_MATCH_TYPES = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "ip_cidr",
] as const;
export const RULE_ACTIONS = ["direct", "proxy", "reject"] as const;
export const RULE_SCOPES = ["client", "server", "both"] as const;

export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];
export type RuleAction = (typeof RULE_ACTIONS)[number];
export type RuleScope = (typeof RULE_SCOPES)[number];

/**
 * A routing rule: one match type with one or more values and the action to
 * take. `scope` decides where it is emitted — `client` into users' Clash
 * subscriptions, `server` into the sing-box config on every proxy server, or
 * both. Server-side rules are enforced by sing-box whose only outbound is
 * `direct`, so only `reject` is meaningful there (validated on write). Lower
 * `sortOrder` is evaluated first.
 */
export const routingRule = pgTable("routing_rule", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  matchType: text("match_type").$type<RuleMatchType>().notNull(),
  values: text("values").array().notNull(),
  action: text("action").$type<RuleAction>().notNull(),
  scope: text("scope").$type<RuleScope>().default("client").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export type RoutingRule = typeof routingRule.$inferSelect;
export type NewRoutingRule = typeof routingRule.$inferInsert;
