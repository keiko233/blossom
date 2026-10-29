import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { account, user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import { node, server } from "@/db/proxy-schema";
import { trafficRecord } from "@/db/traffic-schema";
import { userNote } from "@/db/user-note-schema";
import { bulkMetadata, fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { getAuth } from "@/lib/auth";
import { isEmailEnabled } from "@/lib/email";
import { ensureAdmin } from "@/lib/ensure-admin";
import { planUserBulk } from "@/lib/user-bulk";
import { usersToCsv } from "@/lib/user-csv";
import { buildUserOrderBy, buildUserWhere } from "@/lib/user-filters";
import {
  addUserNoteSchema,
  type BanUserInput,
  banUserSchema,
  type BulkUserResult,
  bulkUserSchema,
  createUserSchema,
  listUsersSchema,
  setUserPasswordSchema,
  setUserRoleSchema,
  updateUserSchema,
  USER_EXPORT_MAX_ROWS,
  userFilterSchema,
  userIdSchema,
  userNoteIdSchema,
  userSessionSchema,
} from "@/orpc/user/schema";
import {
  listServerIdsForUserId,
  recordConfigChange,
} from "@/query/config-change";
import { createSubscription } from "@/query/subscriptions";

/** TanStack Query key for the admin user list. */
export const USERS_QUERY_KEY = ["admin", "users"] as const;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Per-user subscription totals (all statuses) for the given users. */
async function countSubscriptionsByUser(
  userIds: readonly string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ userId: subscription.userId, count: count() })
    .from(subscription)
    .where(inArray(subscription.userId, [...userIds]))
    .groupBy(subscription.userId);
  return new Map(rows.map((row) => [row.userId, row.count]));
}

/** Filtered, sorted and paginated in SQL; `total` is the unpaged match count. */
export const listUsers = createServerFn({ method: "GET" })
  .validator(listUsersSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const where = buildUserWhere(data, new Date());

    const [users, [totalRow]] = await Promise.all([
      db
        .select()
        .from(user)
        .where(where)
        .orderBy(...buildUserOrderBy(data.sort, data.sortDir))
        .limit(data.pageSize)
        .offset((data.page - 1) * data.pageSize),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(user)
        .where(where),
    ]);

    const subCountByUser = await countSubscriptionsByUser(
      users.map((row) => row.id),
    );
    return {
      rows: users.map((row) => ({
        ...row,
        subscriptionCount: subCountByUser.get(row.id) ?? 0,
      })),
      total: totalRow?.total ?? 0,
    };
  });

export type UserListItem = Awaited<
  ReturnType<typeof listUsers>
>["rows"][number];

/**
 * CSV of every user matching the filters (not just one page), capped at
 * USER_EXPORT_MAX_ROWS; `truncated` tells the caller the cap hit.
 */
export const exportUsersCsv = createServerFn({ method: "GET" })
  .validator(userFilterSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const rows = await db
      .select()
      .from(user)
      .where(buildUserWhere(data, new Date()))
      .orderBy(...buildUserOrderBy(data.sort, data.sortDir))
      .limit(USER_EXPORT_MAX_ROWS + 1);
    const truncated = rows.length > USER_EXPORT_MAX_ROWS;
    const exported = truncated ? rows.slice(0, USER_EXPORT_MAX_ROWS) : rows;

    const subCountByUser = await countSubscriptionsByUser(
      exported.map((row) => row.id),
    );
    return {
      csv: usersToCsv(
        exported.map((row) => ({
          ...row,
          subscriptionCount: subCountByUser.get(row.id) ?? 0,
        })),
      ),
      count: exported.length,
      truncated,
    };
  });

/**
 * Everything the user detail page shows: the user row, their subscriptions
 * (with plan names and proxy credentials — this is an admin-only surface),
 * linked auth providers, and the most recent traffic reports.
 */
export const getUserDetail = createServerFn({ method: "GET" })
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.select().from(user).where(eq(user.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }

    const [subscriptions, traffic, accounts] = await Promise.all([
      db
        .select({ subscription, planName: plan.name })
        .from(subscription)
        .innerJoin(plan, eq(plan.id, subscription.planId))
        .where(eq(subscription.userId, data.id))
        .orderBy(desc(subscription.createdAt)),
      // Left-join both node and server: a deleted node nulls nodeName and the
      // denormalized serverId still points at the producing host if it
      // survives. Both gone → deleted.
      db
        .select({
          record: trafficRecord,
          nodeName: node.name,
          serverName: server.name,
        })
        .from(trafficRecord)
        .leftJoin(node, eq(node.id, trafficRecord.nodeId))
        .leftJoin(server, eq(server.id, trafficRecord.serverId))
        .where(eq(trafficRecord.userId, data.id))
        .orderBy(desc(trafficRecord.createdAt))
        .limit(50),
      // Explicit columns: OAuth tokens and the password hash never leave the
      // server.
      db
        .select({
          id: account.id,
          providerId: account.providerId,
          accountId: account.accountId,
          createdAt: account.createdAt,
        })
        .from(account)
        .where(eq(account.userId, data.id))
        .orderBy(account.createdAt),
    ]);

    return { user: row, subscriptions, traffic, accounts };
  });

export type UserDetail = Awaited<ReturnType<typeof getUserDetail>>;

/**
 * Ban/role/delete mutations go through the better-auth admin plugin rather
 * than raw drizzle: banning also revokes the user's sessions and deletion
 * clears their accounts, which direct SQL would skip. The plugin re-checks
 * that the calling session is an admin. The `apply*` helpers below are the
 * single code path shared by the per-user server fns and the bulk action.
 */
async function applyBan(callerId: string, input: BanUserInput) {
  if (callerId === input.userId) {
    throw new Error("Cannot ban yourself");
  }
  // Publish gate: capture the pre-ban state so a later unban can be held
  // back until agents serve the user's credentials again.
  const [preBan] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, input.userId));
  await getAuth().api.banUser({
    headers: getRequestHeaders(),
    body: {
      userId: input.userId,
      banReason: input.reason,
      banExpiresIn: input.expiresInDays
        ? input.expiresInDays * SECONDS_PER_DAY
        : undefined,
    },
  });
  if (preBan && !preBan.banned) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: input.userId,
      prevRow: {
        banned: preBan.banned,
        banExpires: preBan.banExpires?.toISOString() ?? null,
      },
      serverIds: await listServerIdsForUserId(db, input.userId),
    });
  }
}

async function applyUnban(userId: string) {
  const [preUnban] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId));
  await getAuth().api.unbanUser({
    headers: getRequestHeaders(),
    body: { userId },
  });
  // Publish gate: the subscription keeps refusing access until every agent
  // hosting the user's nodes has applied the revision that re-adds them.
  if (preUnban?.banned) {
    await recordConfigChange(db, {
      kind: "authorization",
      subjectId: userId,
      prevRow: {
        banned: preUnban.banned,
        banExpires: preUnban.banExpires?.toISOString() ?? null,
      },
      serverIds: await listServerIdsForUserId(db, userId),
    });
  }
}

async function applySetRole(
  callerId: string,
  userId: string,
  role: "admin" | "user",
) {
  // Self-demotion would lock the last admin out mid-session.
  if (callerId === userId && role !== "admin") {
    throw new Error("Cannot demote yourself");
  }
  await getAuth().api.setRole({
    headers: getRequestHeaders(),
    body: { userId, role },
  });
}

/**
 * Deletes the user and, through the schema's ON DELETE CASCADE, their
 * subscriptions, traffic history and notes. No publish-gate record is written:
 * the gate only replays changes that *add* access (re-activation, new nodes,
 * fresh credentials) and de-activation is already refused at fetch time — the
 * subscription row is gone, so its link stops resolving at once, the same
 * "safe direction" as deleting a node or subscription. A record would also be
 * dead weight: the gate is evaluated per subscription at fetch time and none
 * of this user's subscriptions exist to evaluate it.
 */
async function applyRemove(callerId: string, userId: string) {
  if (callerId === userId) {
    throw new Error("Cannot delete yourself");
  }
  await getAuth().api.removeUser({
    headers: getRequestHeaders(),
    body: { userId },
  });
}

export const banUser = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.ban", {
      targetType: "user",
      targetId: fromInput("userId"),
    }),
  ])
  .validator(banUserSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    await applyBan(session.user.id, data);
    return { id: data.userId };
  });

export const unbanUser = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.unban", { targetType: "user", targetId: fromInput("id") }),
  ])
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    await applyUnban(data.id);
    return { id: data.id };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.set_role", {
      targetType: "user",
      targetId: fromInput("userId"),
    }),
  ])
  .validator(setUserRoleSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    await applySetRole(session.user.id, data.userId, data.role);
    return { id: data.userId };
  });

export const deleteUser = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.delete", {
      targetType: "user",
      targetId: fromInput("id"),
    }),
  ])
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    await applyRemove(session.user.id, data.id);
    return { id: data.id };
  });

/**
 * Applies one action to many users. Each row goes through the same `apply*`
 * helper as its single-user counterpart, one at a time, so a failing row is
 * reported without blocking the rest. The calling admin is skipped.
 */
export const bulkUpdateUsers = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.bulk_update", {
      targetType: "user",
      metadata: bulkMetadata,
    }),
  ])
  .validator(bulkUserSchema)
  .handler(async ({ data }): Promise<BulkUserResult> => {
    const session = await ensureAdmin();
    const callerId = session.user.id;
    const { action } = data;
    const { targets, skipped } = planUserBulk(data.ids, callerId);

    const result: BulkUserResult = { succeeded: 0, failed: [], skipped };
    for (const userId of targets) {
      try {
        switch (action.type) {
          case "ban":
            await applyBan(callerId, {
              userId,
              reason: action.reason,
              expiresInDays: action.expiresInDays,
            });
            break;
          case "unban":
            await applyUnban(userId);
            break;
          case "setRole":
            await applySetRole(callerId, userId, action.role);
            break;
          case "delete":
            await applyRemove(callerId, userId);
            break;
        }
        result.succeeded += 1;
      } catch (error) {
        result.failed.push({
          id: userId,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    return result;
  });

/** Outcome of asking for a magic-link sign-in email. */
export type SignInLinkStatus = "sent" | "email_disabled";

/**
 * Emails a magic sign-in link. Mail only goes out when RESEND is configured;
 * without it better-auth's `sendMagicLink` would merely log the link, so the
 * caller is told `email_disabled` instead of pretending it was sent.
 */
async function sendSignInLink(email: string): Promise<SignInLinkStatus> {
  if (!isEmailEnabled) {
    return "email_disabled";
  }
  await getAuth().api.signInMagicLink({
    headers: getRequestHeaders(),
    body: { email, callbackURL: "/dashboard" },
  });
  return "sent";
}

/**
 * Creates an account through the admin plugin. A blank password creates it
 * without a credential account (magic link / social sign-in only). A plan, if
 * given, is assigned through `createSubscription` so credentials, snapshots
 * and the publish-gate record stay in one place. The plan is checked before
 * the user is created; a failure afterwards leaves the user in place and is
 * reported via `subscriptionFailed`.
 */
export const createUser = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.create", {
      targetType: "user",
      targetId: fromResult("id"),
    }),
  ])
  .validator(createUserSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    if (data.planId) {
      const [planRow] = await db
        .select({ id: plan.id })
        .from(plan)
        .where(eq(plan.id, data.planId));
      if (!planRow) {
        throw new Error("Plan not found");
      }
    }

    const { user: created } = await getAuth().api.createUser({
      headers: getRequestHeaders(),
      body: {
        name: data.name,
        email: data.email,
        password: data.password,
        role: data.role,
      },
    });

    let subscriptionFailed = false;
    if (data.planId) {
      try {
        await createSubscription({
          data: { userId: created.id, planId: data.planId },
        });
      } catch {
        subscriptionFailed = true;
      }
    }

    let signInLink: SignInLinkStatus | "failed" | null = null;
    if (data.sendSignInLink && !data.password) {
      try {
        signInLink = await sendSignInLink(created.email);
      } catch {
        signInLink = "failed";
      }
    }

    return { id: created.id, subscriptionFailed, signInLink };
  });

/**
 * Name, email and verified flag via the plugin's `adminUpdateUser`, which
 * enforces email format and uniqueness.
 */
export const updateUser = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.update", {
      targetType: "user",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateUserSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    await getAuth().api.adminUpdateUser({
      headers: getRequestHeaders(),
      body: {
        userId: data.id,
        data: {
          name: data.name,
          email: data.email,
          emailVerified: data.emailVerified,
        },
      },
    });
    return { id: data.id };
  });

/** Sets (or creates) the credential password; the hash never leaves the server. */
export const setUserPassword = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.set_password", {
      targetType: "user",
      targetId: fromInput("id"),
    }),
  ])
  .validator(setUserPasswordSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    await getAuth().api.setUserPassword({
      headers: getRequestHeaders(),
      body: { userId: data.id, newPassword: data.password },
    });
    return { id: data.id };
  });

export const sendUserSignInLink = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.send_sign_in_link", {
      targetType: "user",
      targetId: fromInput("id"),
    }),
  ])
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    return { status: await sendSignInLink(row.email) };
  });

// --- Sessions ----------------------------------------------------------------

/**
 * Active sessions of a user. The session token is a bearer credential, so it
 * is dropped here; revocation is addressed by session id and resolved back to
 * the token server-side.
 */
async function listSessionsForUser(userId: string) {
  const { sessions } = await getAuth().api.listUserSessions({
    headers: getRequestHeaders(),
    body: { userId },
  });
  return sessions;
}

export const listUserSessions = createServerFn({ method: "GET" })
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    const admin = await ensureAdmin();
    const sessions = await listSessionsForUser(data.id);
    return sessions
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ipAddress: row.ipAddress ?? null,
        userAgent: row.userAgent ?? null,
        // Set when an admin created the session by impersonating the user.
        impersonated: Boolean(row.impersonatedBy),
        isCurrent: row.id === admin.session.id,
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });

export type UserSessionItem = Awaited<
  ReturnType<typeof listUserSessions>
>[number];

export const revokeUserSession = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.revoke_session", {
      targetType: "user",
      targetId: fromInput("userId"),
    }),
  ])
  .validator(userSessionSchema)
  .handler(async ({ data }) => {
    const admin = await ensureAdmin();
    // Resolving through the user's own sessions also proves the id belongs
    // to that user.
    const target = (await listSessionsForUser(data.userId)).find(
      (row) => row.id === data.sessionId,
    );
    if (!target) {
      throw new Error("Not found");
    }
    if (target.id === admin.session.id) {
      throw new Error("Cannot revoke your current session");
    }
    await getAuth().api.revokeUserSession({
      headers: getRequestHeaders(),
      body: { sessionToken: target.token },
    });
    return { id: data.sessionId };
  });

export const revokeUserSessions = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.revoke_sessions", {
      targetType: "user",
      targetId: fromInput("id"),
    }),
  ])
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    const admin = await ensureAdmin();
    if (data.id === admin.user.id) {
      // Signing out everywhere would end this very session: keep it.
      for (const row of await listSessionsForUser(data.id)) {
        if (row.id === admin.session.id) continue;
        await getAuth().api.revokeUserSession({
          headers: getRequestHeaders(),
          body: { sessionToken: row.token },
        });
      }
    } else {
      await getAuth().api.revokeUserSessions({
        headers: getRequestHeaders(),
        body: { userId: data.id },
      });
    }
    return { id: data.id };
  });

/**
 * Starts an impersonation session (one hour by default) and swaps the auth
 * cookie; the admin's own session is parked in a cookie better-auth restores
 * on `stopImpersonating`. Admins can't be impersonated — and neither can
 * oneself.
 */
export const impersonateUser = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.impersonate", {
      targetType: "user",
      targetId: fromInput("id"),
    }),
  ])
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    if (session.user.id === data.id) {
      throw new Error("Cannot impersonate yourself");
    }
    const [target] = await db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, data.id));
    if (!target) {
      throw new Error("Not found");
    }
    if (target.role === "admin") {
      throw new Error("Cannot impersonate an admin");
    }
    await getAuth().api.impersonateUser({
      headers: getRequestHeaders(),
      body: { userId: data.id },
    });
    return { id: data.id };
  });

// --- Notes -------------------------------------------------------------------

const NOTES_LIMIT = 200;

export const listUserNotes = createServerFn({ method: "GET" })
  .validator(userIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const author = alias(user, "note_author");
    return db
      .select({
        id: userNote.id,
        body: userNote.body,
        createdAt: userNote.createdAt,
        authorId: userNote.authorId,
        authorName: author.name,
      })
      .from(userNote)
      .leftJoin(author, eq(author.id, userNote.authorId))
      .where(eq(userNote.userId, data.id))
      .orderBy(desc(userNote.createdAt))
      .limit(NOTES_LIMIT);
  });

export type UserNoteItem = Awaited<ReturnType<typeof listUserNotes>>[number];

export const addUserNote = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.note_add", {
      targetType: "user",
      targetId: fromInput("userId"),
    }),
  ])
  .validator(addUserNoteSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    const [row] = await db
      .insert(userNote)
      .values({
        id: randomUUID(),
        userId: data.userId,
        authorId: session.user.id,
        body: data.body,
      })
      .returning();
    return row;
  });

export const deleteUserNote = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("user.note_delete", {
      targetType: "user_note",
      targetId: fromInput("id"),
    }),
  ])
  .validator(userNoteIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .delete(userNote)
      .where(eq(userNote.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });
