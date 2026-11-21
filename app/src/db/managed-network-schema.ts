import type { ManagedRuleSetFormat } from "@blossom/contracts/agent-config-v3";
import type { ManagedLinkProbeOutcome } from "@blossom/contracts/managed-link-probe";
import type {
  ListenerClaimOwnerKind,
  ManagedOutboundKind,
  ManagedRolloutState,
  ManagedStageState,
  PeerCredentialState,
  PeerProtocol,
} from "@blossom/domain/managed-networking";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type { JsonValue } from "@/orpc/proxy/schema";

import { managedCertificate, server } from "./proxy-schema";

/**
 * Additive persistence for managed networking (Task 06). Nothing here is read
 * by the compiler or the subscription path until
 * `MANAGED_NETWORKING_ACTIVATION_ENABLED` is turned on.
 *
 * Live resources (`peer_inbound`, `peer_link`, `managed_outbound`) restrict
 * deletion of what they reference, so teardown must go through a rollout.
 * Version and rollout history cascades with its server.
 */

// --- Topology fence ---------------------------------------------------------

/**
 * Singleton generation fencing graph validation. Every write that adds or
 * removes a managed forwarding edge, reservation or rollout claim must
 * compare-and-bump it in the same transaction or data-modifying statement.
 * The migration seeds the only row.
 */
export const managedTopology = pgTable(
  "managed_topology",
  {
    id: text("id").primaryKey(),
    generation: integer("generation").default(0).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [check("managed_topology_singleton", sql`${table.id} = 'global'`)],
);

// --- Listener claims --------------------------------------------------------

/**
 * Shared port reservation across runtime kinds, keyed by server and port.
 * Subscriber claims mirror `node.(server_id, listen_port)` through the
 * `node_listener_claim_sync` trigger, so every legacy writer keeps them in step
 * atomically on both drivers. Peer claims are written explicitly by the
 * managed writer and may hold an old and a new port while a move rolls out.
 */
export const listenerClaim = pgTable(
  "listener_claim",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    port: integer("port").notNull(),
    ownerKind: text("owner_kind").$type<ListenerClaimOwnerKind>().notNull(),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.port] }),
    index("listener_claim_owner_idx").on(table.ownerKind, table.ownerId),
    check("listener_claim_port_range", sql`${table.port} BETWEEN 1 AND 65535`),
    check(
      "listener_claim_owner_kind",
      sql`${table.ownerKind} IN ('subscriber_inbound', 'peer_inbound')`,
    ),
  ],
);

// --- Peer resources ---------------------------------------------------------

/**
 * Server-owned listener that admits link identities from other servers. It is
 * never a subscriber entrance: excluded from group membership, exports,
 * subscriber deployment IDs and billable usage.
 */
export const peerInbound = pgTable(
  "peer_inbound",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    runtimeTag: text("runtime_tag").notNull().unique(),
    protocol: text("protocol").$type<PeerProtocol>().notNull(),
    // Bind address and port on the host; the port is reserved in
    // `listener_claim`, not by a unique index here.
    listenAddress: text("listen_address").notNull(),
    listenPort: integer("listen_port").notNull(),
    // What senders dial, kept apart from listen and subscription addresses.
    advertisedAddress: text("advertised_address").notNull(),
    advertisedPort: integer("advertised_port").notNull(),
    tlsServerName: text("tls_server_name").notNull(),
    certificateId: text("certificate_id")
      .notNull()
      .references(() => managedCertificate.id, { onDelete: "restrict" }),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("peer_inbound_server_idx").on(table.serverId)],
);

/** Directed relation from a source server to a destination peer inbound. */
export const peerLink = pgTable(
  "peer_link",
  {
    id: text("id").primaryKey(),
    sourceServerId: text("source_server_id")
      .notNull()
      .references(() => server.id, { onDelete: "restrict" }),
    destinationInboundId: text("destination_inbound_id")
      .notNull()
      .references(() => peerInbound.id, { onDelete: "restrict" }),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    unique("peer_link_source_destination_unique").on(
      table.sourceServerId,
      table.destinationInboundId,
    ),
    // Target of `managed_outbound`'s composite key, which pins a peer outbound
    // to its link's source server.
    unique("peer_link_id_source_unique").on(table.id, table.sourceServerId),
    index("peer_link_destination_idx").on(table.destinationInboundId),
  ],
);

/**
 * Encrypted per-link credential generations. Old generations stay until every
 * stage that may still serve them is retired.
 */
export const peerLinkCredential = pgTable(
  "peer_link_credential",
  {
    linkId: text("link_id")
      .notNull()
      .references(() => peerLink.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    state: text("state")
      .$type<PeerCredentialState>()
      .default("active")
      .notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    retiredAt: timestamp("retired_at"),
  },
  (table) => [primaryKey({ columns: [table.linkId, table.generation] })],
);

/**
 * Named outbound on a server: a direct dial profile, or the one generated
 * outbound of a peer link on the link's source server.
 */
export const managedOutbound = pgTable(
  "managed_outbound",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "restrict" }),
    kind: text("kind").$type<ManagedOutboundKind>().notNull(),
    name: text("name").notNull(),
    runtimeTag: text("runtime_tag").notNull().unique(),
    linkId: text("link_id").unique(),
    // Validated sing-box dial fields for a direct profile; empty for links.
    dialOptions: jsonb("dial_options")
      .$type<Record<string, JsonValue>>()
      .default({})
      .notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("managed_outbound_server_idx").on(table.serverId),
    foreignKey({
      name: "managed_outbound_link_source_fk",
      columns: [table.linkId, table.serverId],
      foreignColumns: [peerLink.id, peerLink.sourceServerId],
    }).onDelete("restrict"),
    check(
      "managed_outbound_kind_link",
      sql`(${table.kind} = 'peer_link' AND ${table.linkId} IS NOT NULL)
        OR (${table.kind} = 'direct_profile' AND ${table.linkId} IS NULL)`,
    ),
  ],
);

// --- Immutable rule-set assets ---------------------------------------------

/**
 * One immutable binary rule-set asset revision. `(rule_set_id, version)` is
 * the identity a managed stage intent references; content is addressed by
 * digest and bounded to 512 KiB raw before the compiler embeds it in a V3
 * snapshot. Rows are never updated in place: a new revision is a new row.
 */
export const managedRuleSetAsset = pgTable(
  "managed_rule_set_asset",
  {
    ruleSetId: text("rule_set_id").notNull(),
    version: text("version").notNull(),
    format: text("format").$type<ManagedRuleSetFormat>().notNull(),
    // Curated provenance: catalog entry, import batch, or operator source.
    source: text("source").notNull(),
    contentBase64: text("content_base64").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ruleSetId, table.version] }),
    check(
      "managed_rule_set_asset_size",
      sql`${table.sizeBytes} BETWEEN 1 AND 524288`,
    ),
    check(
      "managed_rule_set_asset_sha256",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("managed_rule_set_asset_format", sql`${table.format} = 'binary'`),
  ],
);

// --- Immutable intent -------------------------------------------------------

/**
 * Immutable managed intent for one server: peer listeners, outbounds, routing
 * policy, credential generation and artifact references. The compiler reaches
 * it only through `managed_server_state`. A trigger rejects UPDATE; rows are
 * pruned by DELETE once nothing points at them.
 */
export const managedConfigVersion = pgTable(
  "managed_config_version",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    intent: jsonb("intent").$type<JsonValue>().notNull(),
    // "sha256:<hex>" over the structural intent, before dynamic admission and
    // zero-user pruning.
    intentDigest: text("intent_digest").notNull(),
    // Subscriber ingress (`node.id`) this intent scopes policy to. Legacy
    // structural writers reject changes to these nodes outside a stage.
    subscriberNodeIds: jsonb("subscriber_node_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("managed_config_version_server_version_unique").on(
      table.serverId,
      table.version,
    ),
  ],
);

// --- Rollout journal and stage pointers -------------------------------------

/** One applied topology change, admitted at a topology generation. */
export const managedRollout = pgTable(
  "managed_rollout",
  {
    id: text("id").primaryKey(),
    state: text("state")
      .$type<ManagedRolloutState>()
      .default("applying")
      .notNull(),
    // Generation produced by the compare-and-swap that admitted this rollout.
    topologyGeneration: integer("topology_generation").notNull(),
    // Highest stage ordinal whose pointer has been advanced; 0 before the
    // first. Stage advance compares and bumps it.
    currentOrdinal: integer("current_ordinal").default(0).notNull(),
    stageCount: integer("stage_count").notNull(),
    requestedByUserId: text("requested_by_user_id"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("managed_rollout_state_idx").on(table.state),
    check(
      "managed_rollout_ordinal_range",
      sql`${table.currentOrdinal} BETWEEN 0 AND ${table.stageCount}`,
    ),
  ],
);

/**
 * Ordered stage of a rollout targeting one server. A staged subscriber change
 * carries its node write in `subscriberIntent`; the stage-advance command
 * stores the replaced rows in `subscriberPrevious` for compensation.
 */
export const managedRolloutStage = pgTable(
  "managed_rollout_stage",
  {
    rolloutId: text("rollout_id")
      .notNull()
      .references(() => managedRollout.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    state: text("state")
      .$type<ManagedStageState>()
      .default("pending")
      .notNull(),
    configVersionId: text("config_version_id")
      .notNull()
      .references(() => managedConfigVersion.id),
    // Last confirmed compatible version: the recovery target on failure/abort.
    previousConfigVersionId: text("previous_config_version_id").references(
      () => managedConfigVersion.id,
    ),
    // Verified managed-state fingerprint, including required presences and
    // removals, that an applied report must match.
    managedFingerprint: text("managed_fingerprint").notNull(),
    // `server.desired_revision_seq` issued for this attempt; reports below it
    // cannot prove this stage. Written only when the pointer advances.
    minRevisionSeq: integer("min_revision_seq"),
    // Full identifier issued for the attempt. Kept apart from `min_revision_seq`
    // so recovery can record its own identifier without erasing the candidate.
    issuedRevisionSeq: integer("issued_revision_seq"),
    // Link whose probe must succeed after this stage is proven and before the
    // next stage may advance. Null for stages without a peer-path gate.
    probeLinkId: text("probe_link_id").references(() => peerLink.id, {
      onDelete: "set null",
    }),
    subscriberIntent: jsonb("subscriber_intent").$type<JsonValue>(),
    subscriberPrevious: jsonb("subscriber_previous").$type<JsonValue>(),
    // Start when issued; a timeout surfaces as stalled and never confirms.
    deadlineAt: timestamp("deadline_at"),
    issuedAt: timestamp("issued_at"),
    confirmedAt: timestamp("confirmed_at"),
    // Recovery evidence written by a compensation. `recovery_config_version_id`
    // is the existing `previous_config_version_id`; these columns name the
    // identifier and proof window for the restored version.
    recoveryMinRevisionSeq: integer("recovery_min_revision_seq"),
    recoveryManagedFingerprint: text("recovery_managed_fingerprint"),
    recoveryIssuedRevisionSeq: integer("recovery_issued_revision_seq"),
    recoveryIssuedAt: timestamp("recovery_issued_at"),
    recoveryDeadlineAt: timestamp("recovery_deadline_at"),
    recoveryProvenAt: timestamp("recovery_proven_at"),
    failureCode: text("failure_code"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rolloutId, table.ordinal] }),
    index("managed_rollout_stage_server_idx").on(table.serverId, table.state),
    check("managed_rollout_stage_ordinal", sql`${table.ordinal} >= 1`),
  ],
);

/**
 * One bounded link probe issued for a confirmed sender stage. Results are
 * recorded idempotently by `probe_id`, only from the source server's
 * authenticated session and before `expires_at`. The request/result payloads
 * live in `@blossom/contracts/managed-link-probe`; this table persists the
 * identifiers, endpoint generations and outcome so a reconnect or restart can
 * correlate a late result without replaying the request.
 */
export const managedLinkProbe = pgTable(
  "managed_link_probe",
  {
    id: text("id").primaryKey(),
    rolloutId: text("rollout_id").notNull(),
    stageOrdinal: integer("stage_ordinal").notNull(),
    linkId: text("link_id")
      .notNull()
      .references(() => peerLink.id, { onDelete: "cascade" }),
    credentialGeneration: integer("credential_generation").notNull(),
    sourceServerId: text("source_server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    destinationServerId: text("destination_server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    sourceMinRevisionSeq: integer("source_min_revision_seq").notNull(),
    sourceManagedFingerprint: text("source_managed_fingerprint").notNull(),
    destinationMinRevisionSeq: integer(
      "destination_min_revision_seq",
    ).notNull(),
    destinationManagedFingerprint: text(
      "destination_managed_fingerprint",
    ).notNull(),
    issuedAt: timestamp("issued_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    outcome: text("outcome").$type<ManagedLinkProbeOutcome>(),
    latencyMs: integer("latency_ms"),
    appliedDesiredRevisionSeq: integer("applied_desired_revision_seq"),
    appliedManagedFingerprint: text("applied_managed_fingerprint"),
    completedAt: timestamp("completed_at"),
    recordedAt: timestamp("recorded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "managed_link_probe_stage_fk",
      columns: [table.rolloutId, table.stageOrdinal],
      foreignColumns: [
        managedRolloutStage.rolloutId,
        managedRolloutStage.ordinal,
      ],
    }).onDelete("cascade"),
    index("managed_link_probe_stage_idx").on(
      table.rolloutId,
      table.stageOrdinal,
      table.issuedAt,
    ),
    index("managed_link_probe_source_idx").on(
      table.sourceServerId,
      table.issuedAt,
    ),
    check("managed_link_probe_stage_ordinal", sql`${table.stageOrdinal} >= 1`),
    check(
      "managed_link_probe_credential_generation",
      sql`${table.credentialGeneration} >= 1`,
    ),
    check(
      "managed_link_probe_revision_seqs",
      sql`${table.sourceMinRevisionSeq} >= 0 AND ${table.destinationMinRevisionSeq} >= 0`,
    ),
    check(
      "managed_link_probe_expiry",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      "managed_link_probe_outcome",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('succeeded', 'timeout', 'connect_failed', 'tls_failed', 'auth_rejected', 'responder_mismatch', 'generation_mismatch', 'expired', 'isolation_unavailable', 'unsupported')`,
    ),
    check(
      "managed_link_probe_latency",
      sql`${table.latencyMs} IS NULL OR ${table.latencyMs} BETWEEN 0 AND 60000`,
    ),
  ],
);

/**
 * Unique active rollout claim per server. Acquired in stable server ID order
 * together with the topology compare-and-swap; held until recovery proves
 * which routes and credentials remain active.
 */
export const managedRolloutClaim = pgTable(
  "managed_rollout_claim",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => server.id),
    rolloutId: text("rollout_id")
      .notNull()
      .references(() => managedRollout.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at").defaultNow().notNull(),
  },
  (table) => [index("managed_rollout_claim_rollout_idx").on(table.rolloutId)],
);

/**
 * Per-server stage pointers. The compiler loads managed inputs only through
 * `desiredConfigVersionId`; advancing it bumps `server.desired_revision_seq`
 * in the same write. No row, or a null pointer, means the legacy snapshot.
 */
export const managedServerState = pgTable("managed_server_state", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => server.id, { onDelete: "cascade" }),
  desiredConfigVersionId: text("desired_config_version_id").references(
    () => managedConfigVersion.id,
  ),
  desiredRolloutId: text("desired_rollout_id").references(
    () => managedRollout.id,
    { onDelete: "set null" },
  ),
  desiredOrdinal: integer("desired_ordinal"),
  desiredMinRevisionSeq: integer("desired_min_revision_seq"),
  desiredManagedFingerprint: text("desired_managed_fingerprint"),
  appliedConfigVersionId: text("applied_config_version_id").references(
    () => managedConfigVersion.id,
  ),
  appliedManagedFingerprint: text("applied_managed_fingerprint"),
  appliedAt: timestamp("applied_at"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export type ListenerClaim = typeof listenerClaim.$inferSelect;
export type PeerInbound = typeof peerInbound.$inferSelect;
export type PeerLink = typeof peerLink.$inferSelect;
export type PeerLinkCredential = typeof peerLinkCredential.$inferSelect;
export type ManagedOutbound = typeof managedOutbound.$inferSelect;
export type ManagedConfigVersion = typeof managedConfigVersion.$inferSelect;
export type ManagedRuleSetAsset = typeof managedRuleSetAsset.$inferSelect;
export type ManagedRollout = typeof managedRollout.$inferSelect;
export type ManagedRolloutStage = typeof managedRolloutStage.$inferSelect;
export type ManagedLinkProbe = typeof managedLinkProbe.$inferSelect;
export type ManagedServerState = typeof managedServerState.$inferSelect;
