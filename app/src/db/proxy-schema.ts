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
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

import { isValidCertificateDomain } from "@/lib/certificate-domain";
import type { JsonValue, NodeProtocol } from "@/orpc/proxy/schema";

export type AgentRuntimeState =
  | "unknown"
  | "starting"
  | "running"
  | "stopped"
  | "crash_loop";

export type AgentConfigState =
  | "unknown"
  | "applied"
  | "rejected"
  | "apply_failed";

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
    configPollIntervalSeconds: integer("config_poll_interval_seconds")
      .default(60)
      .notNull(),
    heartbeatIntervalSeconds: integer("heartbeat_interval_seconds")
      .default(30)
      .notNull(),

    // Latest runtime/config snapshot reported by the agent. Reachability is
    // still derived from lastSeenAt; these fields describe what sing-box itself
    // is doing and which exact config is serving.
    singBoxVersion: text("sing_box_version"),
    runtimeState: text("runtime_state")
      .$type<AgentRuntimeState>()
      .default("unknown")
      .notNull(),
    configState: text("config_state")
      .$type<AgentConfigState>()
      .default("unknown")
      .notNull(),
    observedRevision: text("observed_revision"),
    appliedRevision: text("applied_revision"),
    activeNodeIds: jsonb("active_node_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    statusReportedAt: timestamp("status_reported_at"),
    lastAppliedAt: timestamp("last_applied_at"),
    lastErrorPhase: text("last_error_phase"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorNodeId: text("last_error_node_id"),
    lastErrorAt: timestamp("last_error_at"),

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

export const CERTIFICATE_KINDS = ["acme", "self_signed"] as const;
export const CERTIFICATE_DNS_MODES = ["cloudflare", "manual"] as const;

export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];
export type CertificateDnsMode = (typeof CERTIFICATE_DNS_MODES)[number];
export type CertificateInstanceState =
  | "pending"
  | "issuing"
  | "waiting_dns"
  | "active"
  | "renewing"
  | "error"
  | "expired";

/** Global certificate policy and issuance state, independent from servers. */
export const managedCertificate = pgTable(
  "managed_certificate",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<CertificateKind>().notNull(),
    domains: jsonb("domains").$type<string[]>().notNull(),
    acmeEmail: text("acme_email"),
    acmeStaging: boolean("acme_staging").default(false).notNull(),
    dnsMode: text("dns_mode").$type<CertificateDnsMode>(),
    selfSignedValidityDays: integer("self_signed_validity_days")
      .default(365)
      .notNull(),
    renewalDaysBeforeExpiry: integer("renewal_days_before_expiry")
      .default(30)
      .notNull(),
    state: text("state")
      .$type<CertificateInstanceState>()
      .default("pending")
      .notNull(),
    desiredGeneration: integer("desired_generation").default(1).notNull(),
    activeMaterialVersion: integer("active_material_version"),
    notBefore: timestamp("not_before"),
    notAfter: timestamp("not_after"),
    fingerprintSha256: text("fingerprint_sha256"),
    challenge:
      jsonb("challenge").$type<
        Array<{ name: string; type: "TXT"; value: string }>
      >(),
    challengeApprovedAt: timestamp("challenge_approved_at"),
    issuanceStateCiphertext: text("issuance_state_ciphertext"),
    issuanceLeaseExpiresAt: timestamp("issuance_lease_expires_at"),
    issuanceAttemptAt: timestamp("issuance_attempt_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("managed_certificate_kind_idx").on(table.kind)],
);

const certificateDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidCertificateDomain, "Invalid DNS name");

export const managedCertificateInsertSchema = createInsertSchema(
  managedCertificate,
  {
    name: (schema) => schema.trim().min(1).max(128),
    kind: z.enum(CERTIFICATE_KINDS),
    domains: z.array(certificateDomainSchema).min(1).max(100),
    acmeEmail: z.email().optional(),
    dnsMode: z.enum(CERTIFICATE_DNS_MODES).optional(),
    selfSignedValidityDays: z.number().int().min(1).max(3650).default(365),
    renewalDaysBeforeExpiry: z.number().int().min(1).max(90).default(30),
  },
);

export type ManagedCertificate = typeof managedCertificate.$inferSelect;

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
    // Managed certificate selection. Null keeps legacy inline/path/acme TLS
    // settings untouched for backwards compatibility.
    certificateId: text("certificate_id").references(
      () => managedCertificate.id,
      { onDelete: "restrict" },
    ),
    tlsServerName: text("tls_server_name"),
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

/** Certificates that a server is allowed to install and use. */
export const certificateServer = pgTable(
  "certificate_server",
  {
    certificateId: text("certificate_id")
      .notNull()
      .references(() => managedCertificate.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(true).notNull(),
    state: text("state")
      .$type<CertificateInstanceState>()
      .default("pending")
      .notNull(),
    desiredGeneration: integer("desired_generation").default(1).notNull(),
    appliedGeneration: integer("applied_generation"),
    lastError: text("last_error"),
    lastActionId: text("last_action_id"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.certificateId, table.serverId] }),
    index("certificate_server_server_idx").on(table.serverId),
    index("certificate_server_state_idx").on(table.state),
  ],
);

/** Encrypted certificate versions issued once by the control plane. */
export const certificateMaterial = pgTable(
  "certificate_material",
  {
    id: text("id").primaryKey(),
    certificateId: text("certificate_id")
      .notNull()
      .references(() => managedCertificate.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    certificateCiphertext: text("certificate_ciphertext").notNull(),
    privateKeyCiphertext: text("private_key_ciphertext").notNull(),
    notBefore: timestamp("not_before").notNull(),
    notAfter: timestamp("not_after").notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("certificate_material_version_unique").on(
      table.certificateId,
      table.version,
    ),
  ],
);

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
