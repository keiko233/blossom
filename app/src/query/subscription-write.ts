import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
  type Plan,
  planGroup,
  type Subscription,
  subscription,
} from "@/db/plan-schema";
import {
  configChange,
  configChangeServer,
  node,
  nodeGroup,
  server,
} from "@/db/proxy-schema";
import {
  authorizationPlanIds,
  needsAuthorizationRecord,
  type SubscriptionPatch,
} from "@/lib/subscription-bulk";
import {
  generateSubscriptionCredentials,
  generateSubscriptionToken,
} from "@/lib/subscription-credentials";
import {
  listServerIdsForPlanIds,
  recordConfigChange,
} from "@/query/config-change";

/**
 * Write side of subscriptions that is shared between admin server functions
 * (`@/query/subscriptions`), the user-facing redeem flow
 * (`@/query/redeem-user`) and owner self-service rotation
 * (`@/query/subscription-self-service`). These are plain functions with no authorization of
 * their own: callers must have established who may do this. They live outside
 * the server-function modules because those are imported by client pages, and
 * a plain exported function that touches `db` would not be stripped from the
 * client bundle the way a server function handler is.
 */

export interface InsertSubscriptionInput {
  userId: string;
  plan: Pick<Plan, "id" | "trafficBytes" | "deviceLimit">;
  startedAt: Date;
  expiresAt: Date;
  /** Pre-chosen id, so a caller can find the row again if a later step fails. */
  id?: string;
}

/**
 * Creates a subscription for a plan and records the publish-gate `credential`
 * change. Quota and device limit are snapshotted so later plan edits don't
 * affect already-granted subscriptions.
 */
export async function insertSubscription(
  input: InsertSubscriptionInput,
): Promise<Subscription> {
  const credentials = generateSubscriptionCredentials();
  const [row] = await db
    .insert(subscription)
    .values({
      id: input.id ?? randomUUID(),
      userId: input.userId,
      planId: input.plan.id,
      startedAt: input.startedAt,
      expiresAt: input.expiresAt,
      trafficQuotaBytes: input.plan.trafficBytes,
      deviceLimit: input.plan.deviceLimit,
      credentialUuid: credentials.uuid,
      credentialPassword: credentials.password,
      token: generateSubscriptionToken(),
    })
    .returning();
  // Publish gate: the fresh credentials are in no running agent config yet,
  // so the subscription holds back its nodes until every server hosting them
  // has applied the revision that introduces this user.
  await recordConfigChange(db, {
    kind: "credential",
    subjectId: row.id,
    prevRow: null,
    serverIds: await listServerIdsForPlanIds(db, [input.plan.id]),
  });
  return row;
}

/**
 * The single place a subscription row is updated: shared by the per-row server
 * fn, the bulk operations and redemptions so all of them emit identical
 * publish-gate records.
 *
 * Publish gate: re-activations (status/expiry moving from ineligible to
 * eligible) and plan changes (node access) change what the agent must serve;
 * hold the subscription payload until every affected server confirms.
 * De-activation directions are already refused at fetch time. A plan change
 * covers the servers of both the old and the new plan.
 */
export async function applySubscriptionUpdate(
  existing: Subscription,
  patch: SubscriptionPatch,
): Promise<Subscription> {
  const [row] = await db
    .update(subscription)
    .set(patch)
    .where(eq(subscription.id, existing.id))
    .returning();
  if (!row) {
    throw new Error("Not found");
  }

  if (needsAuthorizationRecord(existing, row)) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: existing.id,
      prevRow: {
        planId: existing.planId,
        status: existing.status,
        expiresAt: existing.expiresAt.toISOString(),
      },
      serverIds: await listServerIdsForPlanIds(
        db,
        authorizationPlanIds(existing, row),
      ),
    });
  }
  return row;
}

/** Matches the subscription, and, for an owner-scoped call, its owner too. */
function subscriptionWhere(id: string, ownerUserId: string | undefined) {
  return ownerUserId === undefined
    ? eq(subscription.id, id)
    : and(eq(subscription.id, id), eq(subscription.userId, ownerUserId));
}

export interface RotateSubscriptionOptions {
  /**
   * Restricts the operation to a subscription owned by this user. A row that
   * exists but belongs to someone else is reported as "Not found", same as a
   * missing one, so ids cannot be probed. Admin callers omit it.
   */
  ownerUserId?: string;
}

/**
 * Rotates the proxy credentials (uuid + password) and records the publish-gate
 * `credential` change as ONE SQL statement, so there is no point in time (and
 * no failure point) at which the new credentials exist without their gate
 * record, or the gate record without the new credentials. Shared by the admin
 * reset and the owner self-service rotation.
 *
 * Why a single statement: `neon-http` has no interactive transactions and
 * `recordConfigChange` is a sequence of statements, so "read previous
 * credentials, update, record" could (a) leave a window in which a subscriber
 * fetch or an agent poll sees the new credentials with no pending change, (b)
 * lose the record when a later statement fails, and (c) let two concurrent
 * rotations both snapshot the same previous credentials. One statement with
 * data-modifying CTEs commits or rolls back as a unit on every driver:
 *
 *  - `target` selects the row `FOR UPDATE`, and (admin or owner) filters on the
 *    owner there. A concurrent rotation of the same subscription blocks on the
 *    row lock and then re-reads the committed row, so `prev_row` is always the
 *    credentials immediately before THIS rotation and rotations form a chain.
 *  - `affected` locks the servers hosting the plan's enabled nodes in id order
 *    (same set as `listServerIdsForSubscriptionId`), so concurrent rotations
 *    cannot deadlock on servers, and per-server revision sequences are issued
 *    in the order the subscription row was rotated.
 *  - `bumped`, `change`, `links` are exactly what `recordConfigChange` writes:
 *    `desired_revision_seq + 1` per server, a `config_change` row carrying the
 *    previous credentials, and one `config_change_server` link per server at
 *    its new sequence; nothing is written when no server is affected.
 *
 * The new credentials only take effect on a server once its agent applies the
 * recorded revision; until then the subscription keeps emitting the previous
 * credentials for that server's nodes (see `@/lib/publish-gate`). Once applied,
 * the old credentials stop authenticating there. `serverIds` are the servers
 * that must apply the rotation (empty when the plan has no enabled nodes).
 *
 * Readers must read the subscription row BEFORE the pending changes (the
 * subscription route does): a reader that saw the new credentials then
 * necessarily sees the committed change, because both commit together.
 */
export async function rotateSubscriptionCredentials(
  id: string,
  options: RotateSubscriptionOptions = {},
): Promise<{
  row: Subscription;
  serverIds: string[];
  changeId: string | null;
}> {
  const credentials = generateSubscriptionCredentials();
  const ownerFilter =
    options.ownerUserId === undefined
      ? sql``
      : sql` AND ${subscription.userId} = ${options.ownerUserId}::text`;
  const credentialUuid = sql.identifier(subscription.credentialUuid.name);
  const credentialPassword = sql.identifier(
    subscription.credentialPassword.name,
  );
  const executor = db as unknown as {
    execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const result = await executor.execute(sql`
    WITH target AS (
      SELECT ${subscription.id} AS id,
             ${subscription.planId} AS plan_id,
             ${subscription.credentialUuid} AS credential_uuid,
             ${subscription.credentialPassword} AS credential_password
      FROM ${subscription}
      WHERE ${subscription.id} = ${id}::text${ownerFilter}
      FOR UPDATE
    ),
    rotated AS (
      UPDATE ${subscription}
      SET ${credentialUuid} = ${credentials.uuid}::text,
          ${credentialPassword} = ${credentials.password}::text
      FROM target
      WHERE ${subscription.id} = target.id
      RETURNING ${subscription}.*
    ),
    affected AS (
      SELECT ${server.id} AS id
      FROM ${server}
      WHERE ${server.id} IN (
        SELECT ${node.serverId}
        FROM target
        JOIN ${planGroup} ON ${planGroup.planId} = target.plan_id
        JOIN ${nodeGroup} ON ${nodeGroup.groupId} = ${planGroup.groupId}
        JOIN ${node} ON ${node.id} = ${nodeGroup.nodeId}
        WHERE ${node.enabled}
      )
      ORDER BY ${server.id}
      FOR UPDATE
    ),
    bumped AS (
      UPDATE ${server}
      SET ${sql.identifier(server.desiredRevisionSeq.name)} =
        ${server.desiredRevisionSeq} + 1
      FROM affected
      WHERE ${server.id} = affected.id
      RETURNING ${server.id} AS id, ${server.desiredRevisionSeq} AS seq
    ),
    change AS (
      INSERT INTO ${configChange} (
        ${sql.identifier(configChange.id.name)},
        ${sql.identifier(configChange.kind.name)},
        ${sql.identifier(configChange.subjectId.name)},
        ${sql.identifier(configChange.prevRow.name)}
      )
      SELECT ${randomUUID()}::text, 'credential', target.id,
             jsonb_build_object(
               'credentialUuid', target.credential_uuid,
               'credentialPassword', target.credential_password
             )
      FROM target
      WHERE EXISTS (SELECT 1 FROM bumped)
      RETURNING ${configChange.id} AS id
    ),
    links AS (
      INSERT INTO ${configChangeServer} (
        ${sql.identifier(configChangeServer.changeId.name)},
        ${sql.identifier(configChangeServer.serverId.name)},
        ${sql.identifier(configChangeServer.revisionSeq.name)}
      )
      SELECT change.id, bumped.id, bumped.seq
      FROM change CROSS JOIN bumped
      RETURNING 1
    )
    SELECT rotated.*,
           (SELECT id FROM change) AS "__change_id",
           coalesce((SELECT jsonb_agg(id ORDER BY id) FROM bumped), '[]'::jsonb)
             AS "__server_ids"
    FROM rotated
  `);
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  if (!raw) {
    throw new Error("Not found");
  }
  const serverIds = raw.__server_ids;
  return {
    row: mapRow(subscription, raw),
    serverIds: (typeof serverIds === "string"
      ? JSON.parse(serverIds)
      : serverIds) as string[],
    changeId: (raw.__change_id as string | null) ?? null,
  };
}

/** Maps a raw `execute` row (snake_case, driver values) onto the table's type. */
function mapRow(table: typeof subscription, raw: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = raw[column.name];
      if (typeof value === "string" && column.dataType === "object date") {
        return [key, new Date(value.replace(" ", "T") + "Z")];
      }
      return [key, value === null ? null : column.mapFromDriverValue(value)];
    }),
  ) as typeof subscription.$inferSelect;
}

/**
 * Rotates the subscription link token. The old URL stops working immediately;
 * the proxy credentials are untouched, so clients that already imported the
 * config keep connecting. Not a publish-gate change: no agent-side state moves.
 */
export async function rotateSubscriptionToken(
  id: string,
  options: RotateSubscriptionOptions = {},
): Promise<Subscription> {
  const [row] = await db
    .update(subscription)
    .set({ token: generateSubscriptionToken() })
    .where(subscriptionWhere(id, options.ownerUserId))
    .returning();
  if (!row) {
    throw new Error("Not found");
  }
  return row;
}
