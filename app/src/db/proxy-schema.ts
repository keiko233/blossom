import { isValidCertificateDomain } from "@blossom/domain/certificate-domain";
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

export type AgentUpdateState =
  | "unknown"
  | "idle"
  | "up_to_date"
  | "checking"
  | "downloading"
  | "verifying"
  | "applying"
  | "restarting"
  | "failed"
  | "disabled";

export type AgentTransportMode = "http" | "ws";
export type AgentWsCredentialKind = "static" | "oauth";

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
    // Current push-channel transport. HTTP polling remains the fallback, so a
    // closed agent WebSocket returns this to "http" until the next handshake.
    transportMode: text("transport_mode")
      .$type<AgentTransportMode>()
      .default("http")
      .notNull(),
    wsConnectedAt: timestamp("ws_connected_at"),
    // Identity of the current agent WebSocket session (v1 or v2). Each
    // handshake replaces it in one UPDATE, and every durable write from a
    // session is conditional on it, so a replaced connection cannot write.
    wsSessionId: text("ws_session_id"),
    // The credential that started the current v2 session. Static sessions
    // carry only the kind; OAuth sessions carry the active identity's
    // generation and token expiry, so every fenced read and write also fails
    // after revocation, supersession, or token expiry. Raw bearer material is
    // never stored here.
    wsCredentialKind: text("ws_credential_kind").$type<AgentWsCredentialKind>(),
    wsCredentialIdentityId: text("ws_credential_identity_id"),
    wsCredentialGeneration: integer("ws_credential_generation"),
    wsCredentialExpiresAt: timestamp("ws_credential_expires_at"),
    agentVersion: text("agent_version"),
    // Build identity and capability surface reported by the agent on every
    // heartbeat. `agentBuildId` is a stable build tag; `agentCapabilities`
    // drives which V3 contract features the control plane may rely on.
    agentBuildId: text("agent_build_id"),
    agentCapabilities: jsonb("agent_capabilities")
      .$type<string[]>()
      .default([])
      .notNull(),
    // Desired binary versions pushed to the agent on its next config poll.
    // "latest" resolves through the GitHub release feed; null leaves updates
    // entirely to the operator's image/bootstrap settings.
    desiredAgentVersion: text("desired_agent_version"),
    desiredSingBoxVersion: text("desired_sing_box_version"),
    // Last update status reported by the agent for each managed binary.
    agentUpdateState: text("agent_update_state")
      .$type<AgentUpdateState>()
      .default("unknown")
      .notNull(),
    agentUpdateTarget: text("agent_update_target"),
    agentUpdateError: text("agent_update_error"),
    agentUpdateCheckedAt: timestamp("agent_update_checked_at"),
    singBoxUpdateState: text("sing_box_update_state")
      .$type<AgentUpdateState>()
      .default("unknown")
      .notNull(),
    singBoxUpdateTarget: text("sing_box_update_target"),
    singBoxUpdateError: text("sing_box_update_error"),
    singBoxUpdateCheckedAt: timestamp("sing_box_update_checked_at"),
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
    // Publish-gate versioning: `desiredRevisionSeq` is bumped (inside the same
    // write) by every mutation that changes the agent-facing config or the
    // subscription payload; `appliedRevisionSeq` is parsed back out of the
    // agent heartbeat's `appliedRevision` (format "<seq>:<hash>") and only
    // ever moves forward. Subscriptions publish a node's state only as of the
    // owning server's applied seq (see `@/lib/publish-gate`).
    desiredRevisionSeq: integer("desired_revision_seq").default(0).notNull(),
    appliedRevisionSeq: integer("applied_revision_seq").default(0).notNull(),
    // Cached full configuration identifier ("<seq>:sha256:<hex>") served on v2
    // status acknowledgments without compiling. Null means "not compiled since
    // the last change"; the next reader compiles and stores it again.
    desiredConfigRevision: text("desired_config_revision"),
    // Bumped by every invalidation of the cached identifier. Inputs that no
    // publish-gate sequence covers (certificates, routing rules) change the
    // identifier without moving `desiredRevisionSeq`, so a cache write names the
    // version it was compiled at and is refused if an invalidation raced it.
    desiredInputsVersion: integer("desired_inputs_version")
      .default(0)
      .notNull(),
    // The cached identifier is trusted only until this instant. It bounds how
    // long an input with no change record (a subscription that expires with
    // the clock, a temporary ban) can stay unreflected in the identifier.
    desiredConfigValidUntil: timestamp("desired_config_valid_until"),
    // Monotonic server-wide revision for the independent log-level policy.
    // It never feeds `desiredRevisionSeq`; the agent applies log changes
    // separately and the publish gate stays untouched.
    logPolicyRevision: integer("log_policy_revision").default(0).notNull(),
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

export const CERTIFICATE_KINDS = ["acme", "self_signed", "imported"] as const;
export const CERTIFICATE_DNS_MODES = ["cloudflare", "manual"] as const;
export const CERTIFICATE_CHALLENGE_TYPES = ["dns-01", "http-01"] as const;
export const CERTIFICATE_ISSUANCE_MODES = [
  "agent_delegated",
  "legacy_control_plane",
] as const;
export const ACME_PROVIDERS = ["letsencrypt", "zerossl"] as const;

export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];
export type CertificateDnsMode = (typeof CERTIFICATE_DNS_MODES)[number];
export type CertificateChallengeType =
  (typeof CERTIFICATE_CHALLENGE_TYPES)[number];
export type CertificateIssuanceMode =
  (typeof CERTIFICATE_ISSUANCE_MODES)[number];
export type AcmeProvider = (typeof ACME_PROVIDERS)[number];
export type CertificateInstanceState =
  | "pending"
  | "issuing"
  | "waiting_dns"
  | "active"
  | "renewing"
  | "error"
  | "expired"
  | "not_yet_valid";

/** Global certificate policy and issuance state, independent from servers. */
export const managedCertificate = pgTable(
  "managed_certificate",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<CertificateKind>().notNull(),
    domains: jsonb("domains").$type<string[]>().notNull(),
    acmeEmail: text("acme_email"),
    acmeProvider: text("acme_provider")
      .$type<AcmeProvider>()
      .default("letsencrypt")
      .notNull(),
    acmeStaging: boolean("acme_staging").default(false).notNull(),
    /**
     * Legacy rows keep their active material and bindings while the new
     * issuer is selected lazily on the next renewal. Once a delegated job is
     * created the row moves to `agent_delegated`; no CA call is made here.
     */
    issuanceMode: text("issuance_mode")
      .$type<CertificateIssuanceMode>()
      .default("legacy_control_plane")
      .notNull(),
    issuerServerId: text("issuer_server_id").references(() => server.id, {
      onDelete: "set null",
    }),
    /**
     * Legacy `dnsMode` remains for display and migration compatibility. New
     * issuance reads `challengeType`; `dns-01` without Cloudflare automation
     * is completed by an administrator through the same TXT records.
     */
    challengeType: text("challenge_type")
      .$type<CertificateChallengeType>()
      .default("dns-01")
      .notNull(),
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
    pendingMaterialVersion: integer("pending_material_version"),
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
    kind: z.enum(["acme", "self_signed"]),
    domains: z.array(certificateDomainSchema).min(1).max(100),
    acmeEmail: z.email().optional(),
    acmeProvider: z.enum(ACME_PROVIDERS).default("letsencrypt"),
    dnsMode: z.enum(CERTIFICATE_DNS_MODES).optional(),
    selfSignedValidityDays: z.number().int().min(1).max(3650).default(365),
    renewalDaysBeforeExpiry: z.number().int().min(1).max(90).default(30),
  },
);

export type ManagedCertificate = typeof managedCertificate.$inferSelect;

export const CERTIFICATE_ISSUANCE_JOB_STATES = [
  "dispatched",
  "awaiting_dns",
  "finalizing",
  "completed",
  "failed",
  "expired",
] as const;

export type CertificateIssuanceJobState =
  (typeof CERTIFICATE_ISSUANCE_JOB_STATES)[number];

export interface CertificateDnsBrokerRecord {
  fqdn: string;
  value: string;
  providerRecordId: string | null;
}

/**
 * One fenced attempt to issue one certificate generation through one
 * designated agent. The job id is the result fence: a late result from an
 * older job, a different server, or a stale generation is rejected even if
 * the server token is otherwise valid. Historical rows stay for audit, while
 * challenge records are deleted after cleanup/expiry.
 */
export const certificateIssuanceJob = pgTable(
  "certificate_issuance_job",
  {
    id: text("id").primaryKey(),
    certificateId: text("certificate_id")
      .notNull()
      .references(() => managedCertificate.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    issuerServerId: text("issuer_server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    challengeType: text("challenge_type")
      .$type<CertificateChallengeType>()
      .notNull(),
    acmeProvider: text("acme_provider").$type<AcmeProvider>().notNull(),
    acmeStaging: boolean("acme_staging").default(false).notNull(),
    domains: jsonb("domains").$type<string[]>().notNull(),
    state: text("state")
      .$type<CertificateIssuanceJobState>()
      .default("dispatched")
      .notNull(),
    dnsRecords: jsonb("dns_records")
      .$type<CertificateDnsBrokerRecord[]>()
      .default([])
      .notNull(),
    challengeApprovedAt: timestamp("challenge_approved_at"),
    challengeExpiresAt: timestamp("challenge_expires_at").notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    lastDispatchedAt: timestamp("last_dispatched_at"),
    lastErrorPhase: text("last_error_phase"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("certificate_issuance_job_certificate_idx").on(
      table.certificateId,
      table.createdAt,
    ),
    index("certificate_issuance_job_issuer_idx").on(
      table.issuerServerId,
      table.state,
    ),
    index("certificate_issuance_job_state_idx").on(table.state),
  ],
);

export type CertificateIssuanceJob = typeof certificateIssuanceJob.$inferSelect;

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
    // Managed certificate selection. Raw X.509 material (certificate/key/path/
    // acme) and the raw `server_name` are never stored in `settings` — the
    // certificate service and this explicit SNI field own them.
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
    // Truthful, stale-safe acknowledgement state reported by the agent via
    // heartbeat `certificateDeployments`. `installedGeneration`/fingerprint/at
    // record which material the agent has written locally; `inUseAt` marks the
    // moment the binding started actively serving it. `appliedGeneration` and
    // `state` become "active" only while a matching deployment is in use.
    installedGeneration: integer("installed_generation"),
    installedFingerprintSha256: text("installed_fingerprint_sha256"),
    installedAt: timestamp("installed_at"),
    inUseAt: timestamp("in_use_at"),
    lastErrorPhase: text("last_error_phase"),
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
    domains: jsonb("domains").$type<string[]>().notNull(),
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

// --- Config publish gate ----------------------------------------------------

export const CONFIG_CHANGE_KINDS = [
  "node",
  "credential",
  "certificate",
  "authorization",
  "server",
] as const;

export type ConfigChangeKind = (typeof CONFIG_CHANGE_KINDS)[number];

/**
 * One recorded mutation of state that feeds the agent config and/or the
 * subscription payload. `prevRow` carries the pre-change snapshot the
 * publish gate replays while the change is not yet applied on a server
 * (null for creations — the entity simply stays unpublished until applied).
 * Rows become garbage once every linked server has applied them; they are
 * pruned lazily.
 */
export const configChange = pgTable(
  "config_change",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ConfigChangeKind>().notNull(),
    // nodeId | subscriptionId | certificateId | planId | groupId | userId | serverId
    subjectId: text("subject_id").notNull(),
    prevRow: jsonb("prev_row").$type<unknown>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("config_change_subject_idx").on(table.kind, table.subjectId),
  ],
);

/**
 * Links a config change to every server whose agent must apply it, stamped
 * with the per-server revision sequence at which the change becomes
 * effective. A change is published for a server once
 * `server.appliedRevisionSeq >= revisionSeq`.
 */
export const configChangeServer = pgTable(
  "config_change_server",
  {
    changeId: text("change_id")
      .notNull()
      .references(() => configChange.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    revisionSeq: integer("revision_seq").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.changeId, table.serverId] }),
    index("config_change_server_pending_idx").on(
      table.serverId,
      table.revisionSeq,
    ),
  ],
);

export type ConfigChange = typeof configChange.$inferSelect;
export type ConfigChangeServer = typeof configChangeServer.$inferSelect;
