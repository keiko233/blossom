import { sql } from "drizzle-orm";
import {
  check,
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";
import { oauthClient } from "./oauth-schema";
import { server } from "./proxy-schema";

export const AGENT_IDENTITY_STATUSES = [
  "pending",
  "active",
  "superseded",
  "revoked",
] as const;
export const AGENT_ENROLLMENT_MODES = ["enroll", "replace"] as const;
export const AGENT_ENROLLMENT_GRANT_STATUSES = [
  "issued",
  "redeeming",
  "redeemed",
  "revoked",
] as const;

export type AgentIdentityStatus = (typeof AGENT_IDENTITY_STATUSES)[number];
export type AgentEnrollmentMode = (typeof AGENT_ENROLLMENT_MODES)[number];
export type AgentEnrollmentGrantStatus =
  (typeof AGENT_ENROLLMENT_GRANT_STATUSES)[number];

const listSql = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * One-time enrollment grant for a server. Only the SHA-256 hash of the grant
 * secret is stored. `status` moves `issued` → `redeeming` (claimed by one
 * redemption attempt, identified by `attemptId`) → `redeemed` in the same
 * statement that creates the identity. A failed claim goes back to `issued`
 * only when nothing was created. Grants die with their server.
 */
export const agentEnrollmentGrant = pgTable(
  "agent_enrollment_grant",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "cascade" }),
    mode: text("mode").$type<AgentEnrollmentMode>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    release: text("release"),
    status: text("status")
      .$type<AgentEnrollmentGrantStatus>()
      .default("issued")
      .notNull(),
    attemptId: text("attempt_id").unique(),
    claimedAt: timestamp("claimed_at"),
    redeemedAt: timestamp("redeemed_at"),
    revokedAt: timestamp("revoked_at"),
    expiresAt: timestamp("expires_at").notNull(),
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
    index("agent_enrollment_grant_server_idx").on(table.serverId),
    check(
      "agent_enrollment_grant_mode_check",
      sql`${table.mode} in (${listSql(AGENT_ENROLLMENT_MODES)})`,
    ),
    check(
      "agent_enrollment_grant_status_check",
      sql`${table.status} in (${listSql(AGENT_ENROLLMENT_GRANT_STATUSES)})`,
    ),
  ],
);

export type AgentEnrollmentGrant = typeof agentEnrollmentGrant.$inferSelect;
export type NewAgentEnrollmentGrant = typeof agentEnrollmentGrant.$inferInsert;

/**
 * The OAuth machine identity of one server. Each identity owns one
 * `oauth_client` (confidential, `client_credentials`, linked only to the agent
 * resource). `server_id` is the only server mapping that agent tokens are
 * resolved through.
 *
 * Invariants enforced by partial unique indexes: at most one `active` and one
 * `pending` identity per server, and generations are unique per server.
 * `restrict` on the server and client keeps a live identity from being
 * deleted by accident; revocation is the supported removal path.
 */
export const agentIdentity = pgTable(
  "agent_identity",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => server.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    oauthClientId: text("oauth_client_id")
      .notNull()
      .unique()
      .references(() => oauthClient.clientId, { onDelete: "restrict" }),
    status: text("status").$type<AgentIdentityStatus>().notNull(),
    grantId: text("grant_id").references(() => agentEnrollmentGrant.id, {
      onDelete: "set null",
    }),
    // Identifies the redemption attempt that created the identity and its
    // client, so an orphaned attempt can be found and revoked.
    attemptId: text("attempt_id").notNull().unique(),
    operatorUserId: text("operator_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    activatedAt: timestamp("activated_at"),
    revokedAt: timestamp("revoked_at"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("agent_identity_server_generation_uidx").on(
      table.serverId,
      table.generation,
    ),
    uniqueIndex("agent_identity_server_active_uidx")
      .on(table.serverId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("agent_identity_server_pending_uidx")
      .on(table.serverId)
      .where(sql`${table.status} = 'pending'`),
    check(
      "agent_identity_status_check",
      sql`${table.status} in (${listSql(AGENT_IDENTITY_STATUSES)})`,
    ),
  ],
);

export type AgentIdentity = typeof agentIdentity.$inferSelect;
export type NewAgentIdentity = typeof agentIdentity.$inferInsert;
