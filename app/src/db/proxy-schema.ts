import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type { JsonValue, NodeProtocol } from "@/orpc/proxy/schema";

/**
 * A server is one physical proxy host managed by a single Rust server-agent:
 * it owns the agent token, heartbeat, agent version, and a default public
 * address. One server has many nodes, each compiled into a separate sing-box
 * inbound that the agent pulls as a single multi-inbound config. The agent
 * authenticates with `server.agentTokenHash`; nodes inherit no token of their
 * own.
 */
export const server = pgTable(
  "server",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    remark: text("remark"),
    enabled: boolean("enabled").default(true).notNull(),

    // Public host clients connect to (domain or IP). Used by a node only when
    // the node has no address override of its own.
    address: text("address").notNull(),

    // Server-level agent credential (Authorization: Bearer <token>) shared by
    // every node running on the host. Only a SHA-256 hash is stored; the
    // plaintext is returned once at create/reset time. The prefix is kept for
    // display/identification.
    agentTokenHash: text("agent_token_hash").notNull().unique(),
    agentTokenPrefix: text("agent_token_prefix").notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    agentVersion: text("agent_version"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("server_enabled_idx").on(table.enabled)],
);

export type Server = typeof server.$inferSelect;
export type NewServer = typeof server.$inferInsert;

/**
 * A proxy node is one sing-box inbound on a server. Node-level metadata lives
 * in columns; the protocol configuration is a native sing-box inbound fragment
 * kept in the `settings` jsonb (minus the fields the compiler injects). New
 * protocols need no migration. The full sing-box config for the owning server is
 * compiled on demand (see `@/orpc/proxy/singbox`).
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

    // The owning server. Deletion of a server with nodes is forbidden by the
    // CRUD layer and reinforced by RESTRICT here.
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "restrict" }),

    // Optional public address override; when null the node falls back to
    // `server.address`. Same physical host, so listen_port is unique within a
    // server regardless of the override.
    address: text("address"),
    listenPort: integer("listen_port").notNull(),

    protocol: text("protocol").$type<NodeProtocol>().notNull(),
    // Native sing-box inbound fragment for this protocol, minus the fields the
    // compiler injects (type/tag/listen/listen_port/users). Validated against the
    // sing-box schema for `protocol` on write.
    settings: jsonb("settings")
      .$type<Record<string, JsonValue>>()
      .default({})
      .notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("node_protocol_idx").on(table.protocol),
    index("node_server_idx").on(table.serverId),
    // All inbounds listen on the same physical host, so a port must be unique
    // within a server — regardless of any per-node address override.
    unique("node_server_listen_port_unique").on(
      table.serverId,
      table.listenPort,
    ),
  ],
);

export type Node = typeof node.$inferSelect;
export type NewNode = typeof node.$inferInsert;

/**
 * A proxy group bundles nodes for access control. Nodes are not directly usable
 * by end users; plans grant access to groups, and groups resolve to nodes
 * (see `plan_group` / `subscription` in `@/db/plan-schema`).
 * Named `proxy_group` because `group` is a SQL reserved word.
 */
export const proxyGroup = pgTable("proxy_group", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  remark: text("remark"),
  sortOrder: integer("sort_order").default(0).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

/** Node <-> group membership (many-to-many). */
export const nodeGroup = pgTable(
  "node_group",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => proxyGroup.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.groupId] }),
    index("node_group_group_idx").on(table.groupId),
  ],
);

export type ProxyGroup = typeof proxyGroup.$inferSelect;
export type NewProxyGroup = typeof proxyGroup.$inferInsert;
