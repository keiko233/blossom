import { createServerFn } from "@tanstack/react-start";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan } from "@/db/plan-schema";
import { redeemBatch, redeemCode, redeemRedemption } from "@/db/redeem-schema";
import { fromInput, fromResult } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  getRedeemBatchStatus,
  REDEEM_CODES_PER_BATCH_MAX,
} from "@/lib/redeem-batch";
import {
  generateRedeemCode,
  normalizeRedeemCode,
  REDEEM_CODE_PREFIX_LENGTH,
} from "@/lib/redeem-code";
import { redemptionsToCsv } from "@/lib/redeem-csv";
import {
  buildRedeemBatchOrderBy,
  buildRedeemBatchWhere,
  redeemCodeCountSql,
  redeemRedeemedSql,
} from "@/lib/redeem-filters";
import { escapeLikePattern } from "@/lib/subscription-filters";
import {
  addRedeemCodesSchema,
  createRedeemBatchSchema,
  exportRedemptionsSchema,
  listRedeemBatchesSchema,
  listRedeemCodesSchema,
  listRedeemRedemptionsSchema,
  REDEEM_EXPORT_MAX_ROWS,
  redeemBatchIdSchema,
  updateRedeemBatchSchema,
  updateRedeemCodeSchema,
} from "@/orpc/redeem/schema";

/** TanStack Query key for everything on the admin redeem pages. */
export const REDEEM_QUERY_KEY = ["admin", "redeem"] as const;

const batchColumns = {
  id: redeemBatch.id,
  name: redeemBatch.name,
  planId: redeemBatch.planId,
  planName: plan.name,
  planDurationDays: plan.durationDays,
  mode: redeemBatch.mode,
  durationDays: redeemBatch.durationDays,
  maxRedemptionsPerCode: redeemBatch.maxRedemptionsPerCode,
  perUserLimit: redeemBatch.perUserLimit,
  expiresAt: redeemBatch.expiresAt,
  disabled: redeemBatch.disabled,
  note: redeemBatch.note,
  createdById: redeemBatch.createdById,
  createdByName: user.name,
  createdAt: redeemBatch.createdAt,
  updatedAt: redeemBatch.updatedAt,
  codeCount: redeemCodeCountSql,
  redeemed: redeemRedeemedSql,
};

function withStatus<
  T extends {
    disabled: boolean;
    expiresAt: Date | null;
    codeCount: number;
    redeemed: number;
    maxRedemptionsPerCode: number;
  },
>(row: T, now: Date) {
  return { ...row, status: getRedeemBatchStatus(row, now) };
}

/** Filtered, sorted and paginated in SQL; `total` is the unpaged match count. */
export const listRedeemBatches = createServerFn({ method: "GET" })
  .validator(listRedeemBatchesSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const now = new Date();
    const where = buildRedeemBatchWhere(data, now);

    const [rows, [totalRow]] = await Promise.all([
      db
        .select(batchColumns)
        .from(redeemBatch)
        .innerJoin(plan, eq(plan.id, redeemBatch.planId))
        .leftJoin(user, eq(user.id, redeemBatch.createdById))
        .where(where)
        .orderBy(...buildRedeemBatchOrderBy(data.sort, data.sortDir))
        .limit(data.pageSize)
        .offset((data.page - 1) * data.pageSize),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(redeemBatch)
        .where(where),
    ]);
    return {
      rows: rows.map((row) => withStatus(row, now)),
      total: totalRow?.total ?? 0,
    };
  });

export type RedeemBatchListItem = Awaited<
  ReturnType<typeof listRedeemBatches>
>["rows"][number];

/** One batch plus whether anything was redeemed (which locks its plan/mode). */
export const getRedeemBatch = createServerFn({ method: "GET" })
  .validator(redeemBatchIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const now = new Date();
    const [row] = await db
      .select(batchColumns)
      .from(redeemBatch)
      .innerJoin(plan, eq(plan.id, redeemBatch.planId))
      .leftJoin(user, eq(user.id, redeemBatch.createdById))
      .where(eq(redeemBatch.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    const [redemptions] = await db
      .select({ total: count() })
      .from(redeemRedemption)
      .where(eq(redeemRedemption.batchId, data.id));
    return {
      ...withStatus(row, now),
      redemptionCount: Number(redemptions?.total ?? 0),
    };
  });

export type RedeemBatchDetail = Awaited<ReturnType<typeof getRedeemBatch>>;

/** Codes of a batch, never their plaintext: prefix, uses and state. */
export const listRedeemCodes = createServerFn({ method: "GET" })
  .validator(listRedeemCodesSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const conditions: SQL[] = [eq(redeemCode.batchId, data.batchId)];
    const search = data.search
      ? normalizeRedeemCode(data.search).slice(0, REDEEM_CODE_PREFIX_LENGTH)
      : "";
    if (search) {
      conditions.push(
        ilike(redeemCode.prefix, `${escapeLikePattern(search)}%`),
      );
    }
    const where = and(...conditions);

    const [rows, [totalRow]] = await Promise.all([
      db
        .select({
          id: redeemCode.id,
          prefix: redeemCode.prefix,
          redemptionCount: redeemCode.redemptionCount,
          disabled: redeemCode.disabled,
          createdAt: redeemCode.createdAt,
        })
        .from(redeemCode)
        .where(where)
        .orderBy(desc(redeemCode.createdAt), desc(redeemCode.id))
        .limit(data.pageSize)
        .offset((data.page - 1) * data.pageSize),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(redeemCode)
        .where(where),
    ]);
    return { rows, total: totalRow?.total ?? 0 };
  });

export type RedeemCodeListItem = Awaited<
  ReturnType<typeof listRedeemCodes>
>["rows"][number];

const redemptionColumns = {
  id: redeemRedemption.id,
  userId: user.id,
  userName: user.name,
  userEmail: user.email,
  codePrefix: redeemCode.prefix,
  subscriptionId: redeemRedemption.subscriptionId,
  createdAt: redeemRedemption.createdAt,
};

export const listRedeemRedemptions = createServerFn({ method: "GET" })
  .validator(listRedeemRedemptionsSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const where = eq(redeemRedemption.batchId, data.batchId);
    const [rows, [totalRow]] = await Promise.all([
      db
        .select(redemptionColumns)
        .from(redeemRedemption)
        .innerJoin(redeemCode, eq(redeemCode.id, redeemRedemption.codeId))
        .innerJoin(user, eq(user.id, redeemRedemption.userId))
        .where(where)
        .orderBy(desc(redeemRedemption.createdAt), desc(redeemRedemption.id))
        .limit(data.pageSize)
        .offset((data.page - 1) * data.pageSize),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(redeemRedemption)
        .where(where),
    ]);
    return { rows, total: totalRow?.total ?? 0 };
  });

export type RedeemRedemptionListItem = Awaited<
  ReturnType<typeof listRedeemRedemptions>
>["rows"][number];

/**
 * CSV of every redemption of a batch, capped at REDEEM_EXPORT_MAX_ROWS;
 * `truncated` tells the caller the cap hit. Codes appear as prefixes only.
 */
export const exportRedemptionsCsv = createServerFn({ method: "GET" })
  .validator(exportRedemptionsSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const rows = await db
      .select(redemptionColumns)
      .from(redeemRedemption)
      .innerJoin(redeemCode, eq(redeemCode.id, redeemRedemption.codeId))
      .innerJoin(user, eq(user.id, redeemRedemption.userId))
      .where(eq(redeemRedemption.batchId, data.batchId))
      .orderBy(desc(redeemRedemption.createdAt), desc(redeemRedemption.id))
      .limit(REDEEM_EXPORT_MAX_ROWS + 1);
    const truncated = rows.length > REDEEM_EXPORT_MAX_ROWS;
    const exported = truncated ? rows.slice(0, REDEEM_EXPORT_MAX_ROWS) : rows;
    return {
      csv: redemptionsToCsv(exported),
      count: exported.length,
      truncated,
    };
  });

/**
 * Generates and stores `total` new codes for a batch and returns their
 * plaintext. Only the hashes are persisted; the plaintext leaves this function
 * exactly once, in the return value. A hash collision (astronomically
 * unlikely at ~99 bits) is skipped by `ON CONFLICT DO NOTHING` and the missing
 * codes are regenerated, so the caller always gets exactly `total` codes.
 */
async function insertRedeemCodes(
  batchId: string,
  total: number,
): Promise<string[]> {
  const accepted: string[] = [];
  for (let round = 0; round < 5 && accepted.length < total; round++) {
    const wanted = total - accepted.length;
    const generated = new Map<string, { code: string; prefix: string }>();
    while (generated.size < wanted) {
      const next = generateRedeemCode();
      generated.set(next.hash, { code: next.code, prefix: next.prefix });
    }
    const inserted = await db
      .insert(redeemCode)
      .values(
        [...generated].map(([hash, { prefix }]) => ({
          id: randomUUID(),
          batchId,
          codeHash: hash,
          prefix,
        })),
      )
      .onConflictDoNothing({ target: redeemCode.codeHash })
      .returning();
    for (const { codeHash } of inserted) {
      accepted.push(generated.get(codeHash)!.code);
    }
  }
  if (accepted.length < total) {
    throw new Error("Could not generate unique codes");
  }
  return accepted;
}

export const createRedeemBatch = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("redeem.batch_create", {
      targetType: "redeem_batch",
      targetId: fromResult("batch", "id"),
    }),
  ])
  .validator(createRedeemBatchSchema)
  .handler(async ({ data }) => {
    const session = await ensureAdmin();
    const { codeCount, ...fields } = data;

    const [planRow] = await db
      .select({ id: plan.id })
      .from(plan)
      .where(eq(plan.id, fields.planId));
    if (!planRow) {
      throw new Error("Plan not found");
    }

    // Sequential statements: the neon-http driver has no interactive
    // transactions. The batch row goes first; if generating codes fails it is
    // removed again so no empty batch is left behind.
    const [batch] = await db
      .insert(redeemBatch)
      .values({ id: randomUUID(), ...fields, createdById: session.user.id })
      .returning();
    try {
      const codes = await insertRedeemCodes(batch.id, codeCount);
      // The plaintext codes are returned to the caller and nowhere else: the
      // audit middleware stores the redacted input and resolves only the id
      // below from this result.
      return { batch, codes };
    } catch (error) {
      await db.delete(redeemBatch).where(eq(redeemBatch.id, batch.id));
      throw error;
    }
  });

export const addRedeemCodes = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("redeem.codes_add", {
      targetType: "redeem_batch",
      targetId: fromInput("batchId"),
    }),
  ])
  .validator(addRedeemCodesSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [batch] = await db
      .select({ id: redeemBatch.id, name: redeemBatch.name })
      .from(redeemBatch)
      .where(eq(redeemBatch.id, data.batchId));
    if (!batch) {
      throw new Error("Not found");
    }
    const [existing] = await db
      .select({ total: count() })
      .from(redeemCode)
      .where(eq(redeemCode.batchId, data.batchId));
    if (
      Number(existing?.total ?? 0) + data.count >
      REDEEM_CODES_PER_BATCH_MAX
    ) {
      throw new Error("Batch code limit reached");
    }
    return {
      batchId: batch.id,
      batchName: batch.name,
      codes: await insertRedeemCodes(batch.id, data.count),
    };
  });

export const updateRedeemBatch = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("redeem.batch_update", {
      targetType: "redeem_batch",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateRedeemBatchSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, planId, mode, durationDays, ...mutable } = data;

    const [existing] = await db
      .select()
      .from(redeemBatch)
      .where(eq(redeemBatch.id, id));
    if (!existing) {
      throw new Error("Not found");
    }

    // Plan, mode and duration define what a redemption grants: they stop being
    // editable once any code was redeemed. Unchanged values are ignored so a
    // form may always submit the full set.
    const locked: Partial<
      Pick<typeof existing, "planId" | "mode" | "durationDays">
    > = {};
    if (planId !== undefined && planId !== existing.planId) {
      const [planRow] = await db
        .select({ id: plan.id })
        .from(plan)
        .where(eq(plan.id, planId));
      if (!planRow) {
        throw new Error("Plan not found");
      }
      locked.planId = planId;
    }
    if (mode !== undefined && mode !== existing.mode) locked.mode = mode;
    if (durationDays !== undefined && durationDays !== existing.durationDays) {
      locked.durationDays = durationDays;
    }
    const changesLocked = Object.keys(locked).length > 0;
    const values = { ...mutable, ...locked };
    if (Object.values(values).every((value) => value === undefined)) {
      return existing;
    }

    const [row] = await db
      .update(redeemBatch)
      .set(values)
      .where(
        and(
          eq(redeemBatch.id, id),
          // The guard is part of the UPDATE, so a redemption landing between
          // the read above and this write cannot slip a change through.
          changesLocked
            ? notExists(
                db
                  .select({ one: sql`1` })
                  .from(redeemRedemption)
                  .where(eq(redeemRedemption.batchId, redeemBatch.id)),
              )
            : undefined,
        ),
      )
      .returning();
    if (!row) {
      throw new Error("Batch has redemptions");
    }
    return row;
  });

export const updateRedeemCode = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("redeem.code_update", {
      targetType: "redeem_code",
      targetId: fromInput("id"),
    }),
  ])
  .validator(updateRedeemCodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .update(redeemCode)
      .set({ disabled: data.disabled })
      .where(eq(redeemCode.id, data.id))
      .returning({
        id: redeemCode.id,
        batchId: redeemCode.batchId,
        disabled: redeemCode.disabled,
      });
    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

/** Deleting is only possible while nothing was redeemed; disable otherwise. */
export const deleteRedeemBatch = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("redeem.batch_delete", {
      targetType: "redeem_batch",
      targetId: fromInput("id"),
    }),
  ])
  .validator(redeemBatchIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    // The "no redemptions" guard is part of the DELETE, so a redemption that
    // lands first makes it match nothing rather than being cascaded away.
    const [row] = await db
      .delete(redeemBatch)
      .where(
        and(
          eq(redeemBatch.id, data.id),
          notExists(
            db
              .select({ one: sql`1` })
              .from(redeemRedemption)
              .where(eq(redeemRedemption.batchId, redeemBatch.id)),
          ),
        ),
      )
      .returning();
    if (!row) {
      const [found] = await db
        .select({ id: redeemBatch.id })
        .from(redeemBatch)
        .where(eq(redeemBatch.id, data.id));
      throw new Error(found ? "Batch has redemptions" : "Not found");
    }
    return { id: row.id };
  });
