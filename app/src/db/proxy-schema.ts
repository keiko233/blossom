import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import type { JsonValue, NodeProtocol } from "@/orpc/proxy/schema";

/**
 * A proxy node is one sing-box inbound managed by a remote agent. Node-level metadata
 * lives in columns; the protocol configuration is a native sing-box inbound fragment
 * kept in the `settings` jsonb (minus the fields the compiler injects). New protocols
 * need no migration. The full sing-box config is compiled on demand (see `@/orpc/proxy/singbox`).
 */
export const node = pgTable(
  "node",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    remark: text("remark"),
    // Free-form labels used for grouping and filtering in the admin UI.
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    enabled: boolean("enabled").default(true).notNull(),

    // Public host clients connect to (domain or IP), independent of the listen port.
    address: text("address").notNull(),
    listenPort: integer("listen_port").notNull(),

    protocol: text("protocol").$type<NodeProtocol>().notNull(),
    // Native sing-box inbound fragment for this protocol, minus the fields the
    // compiler injects (type/tag/listen/listen_port/users). Validated against the
    // sing-box schema for `protocol` on write.
    settings: jsonb("settings")
      .$type<Record<string, JsonValue>>()
      .default({})
      .notNull(),

    // Per-node credential the agent presents (Authorization: Bearer <token>) to pull
    // its config and post heartbeats. Only a SHA-256 hash is stored; the plaintext is
    // returned once at create/reset time. The prefix is kept for display/identification.
    agentTokenHash: text("agent_token_hash").notNull().unique(),
    agentTokenPrefix: text("agent_token_prefix").notNull(),
    // Updated on each heartbeat; used to derive online status.
    lastSeenAt: timestamp("last_seen_at"),
    agentVersion: text("agent_version"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("node_protocol_idx").on(table.protocol)],
);

export type Node = typeof node.$inferSelect;
export type NewNode = typeof node.$inferInsert;
