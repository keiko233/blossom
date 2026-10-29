import {
  and,
  count,
  eq,
  exists,
  gt,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import {
  type RedeemBatch,
  type RedeemCode,
  redeemAttempt,
  redeemBatch,
  redeemCode,
  redeemRedemption,
} from "@/db/redeem-schema";
import { isUniqueViolation } from "@/lib/pg-error";
import type { RedeemFailureReason, RedeemResult } from "@/lib/redeem-batch";
import {
  hashRedeemCode,
  isWellFormedRedeemCode,
  normalizeRedeemCode,
} from "@/lib/redeem-code";
import { planRedeemGrant } from "@/lib/redeem-grant";
import {
  attemptRetentionCutoff,
  isRedeemThrottled,
  throttleWindowStart,
} from "@/lib/redeem-throttle";
import {
  applySubscriptionUpdate,
  insertSubscription,
} from "@/query/subscription-write";

/**
 * The redeem flow, as plain functions (no authorization of their own: the
 * caller passes the session user). Kept out of the server-function module
 * (`@/query/redeem-user`) so it is never part of a client bundle.
 *
 * There are no interactive transactions on neon-http, so correctness never
 * relies on one. Every step is a single statement, and the steps that must not
 * be raced are made safe by the database itself:
 *
 *  1. record the attempt (throttle) -> over budget? stop.
 *  2. read the code + batch by hash and run the cheap checks (fast path only;
 *     nothing below trusts them).
 *  3. CLAIM a use: one conditional UPDATE that increments `redemption_count`
 *     only while it is below the cap, the code is enabled and the batch is
 *     enabled and unexpired. Concurrent redeemers serialize on the row; the
 *     loser's UPDATE matches no row.
 *  4. INSERT the redemption. The unique (code, user) index rejects the same
 *     user redeeming the same code twice, however the requests interleave.
 *  5. VERIFY the per-user limit: count the user's redemptions in the batch
 *     (their own row included). Over the limit -> undo. When two requests race
 *     past the limit each sees the other's committed row, so at least one
 *     undoes; both may (the safe direction: never over-grants).
 *  6. GRANT through the gate-aware subscription writers. A failure undoes 3-4.
 *  7. link the redemption to the subscription and forgive the attempt.
 *
 * Undo ("compensation") deletes the redemption row and decrements the claimed
 * use (and removes a subscription created in step 6 / restores an extended
 * one). Each undo step is best effort and logged; see the residual risks
 * below.
 *
 * Residual risks (accepted, inherent to statement-by-statement execution):
 *  - A process crash, or a database outage that also defeats the undo, between
 *    steps 3 and 6 leaves a use consumed without a subscription (or a
 *    redemption row with a null subscription). The user can retry only if the
 *    code still has uses; an admin sees the redemption with no subscription
 *    link and can grant one manually.
 *  - In `extend` mode a failure inside step 6 after the update landed but
 *    before the gate record was written is repaired by restoring the previous
 *    expiry/quota; if that restore also fails the extension stays (logged).
 *  - Per-user limit racing (step 5) can reject both of two simultaneous
 *    redemptions by one user; they just retry.
 */

export interface RedeemParams {
  userId: string;
  /** Raw text from the form. */
  input: string;
  /** Client IP, or null when it cannot be determined. */
  ip: string | null;
  now?: Date;
}

function logCompensation(step: string, error: unknown): void {
  console.error(`[redeem] compensation failed: ${step}`, error);
}

/** Records the attempt and answers whether the caller is over budget. */
async function recordAttempt(
  userId: string,
  ip: string | null,
  now: Date,
): Promise<{ attemptId: string; throttled: boolean }> {
  const attemptId = randomUUID();
  // Recorded BEFORE the code is checked, so parallel guesses all see each
  // other in the count below instead of each seeing a stale total.
  await db
    .insert(redeemAttempt)
    .values({ id: attemptId, userId, ip, createdAt: now });

  const windowStart = throttleWindowStart(now);
  const [[userRow], ipRows] = await Promise.all([
    db
      .select({ total: count() })
      .from(redeemAttempt)
      .where(
        and(
          eq(redeemAttempt.userId, userId),
          gt(redeemAttempt.createdAt, windowStart),
        ),
      ),
    ip
      ? db
          .select({ total: count() })
          .from(redeemAttempt)
          .where(
            and(
              eq(redeemAttempt.ip, ip),
              gt(redeemAttempt.createdAt, windowStart),
            ),
          )
      : Promise.resolve(null),
  ]);

  // Opportunistic pruning keeps the table small without a scheduled job.
  void db
    .delete(redeemAttempt)
    .where(lte(redeemAttempt.createdAt, attemptRetentionCutoff(now)))
    .catch((error) => logCompensation("prune attempts", error));

  return {
    attemptId,
    throttled: isRedeemThrottled({
      user: Number(userRow?.total ?? 0),
      ip: ipRows ? Number(ipRows[0]?.total ?? 0) : null,
    }),
  };
}

/** The attempt turned out not to be a failed guess: it must not count. */
async function forgiveAttempt(attemptId: string): Promise<void> {
  try {
    await db.delete(redeemAttempt).where(eq(redeemAttempt.id, attemptId));
  } catch (error) {
    logCompensation("forgive attempt", error);
  }
}

function isBanned(
  row: { banned: boolean | null; banExpires: Date | null },
  now: Date,
) {
  return Boolean(row.banned) && (!row.banExpires || row.banExpires > now);
}

/** Cheap pre-checks on already-loaded rows; the claim re-checks atomically. */
function isCodeUsable(
  code: RedeemCode,
  batch: RedeemBatch,
  now: Date,
): boolean {
  return (
    !batch.disabled &&
    !(batch.expiresAt && batch.expiresAt.getTime() <= now.getTime()) &&
    !code.disabled &&
    code.redemptionCount < batch.maxRedemptionsPerCode
  );
}

/** Step 3: the atomic claim. True when this request got a use. */
async function claimUse(
  code: RedeemCode,
  batch: RedeemBatch,
  now: Date,
): Promise<boolean> {
  const claimed = await db
    .update(redeemCode)
    .set({ redemptionCount: sql`${redeemCode.redemptionCount} + 1` })
    .where(
      and(
        eq(redeemCode.id, code.id),
        lt(redeemCode.redemptionCount, batch.maxRedemptionsPerCode),
        eq(redeemCode.disabled, false),
        // The batch may have been disabled or expired since step 2.
        exists(
          db
            .select({ one: sql`1` })
            .from(redeemBatch)
            .where(
              and(
                eq(redeemBatch.id, redeemCode.batchId),
                eq(redeemBatch.disabled, false),
                or(
                  isNull(redeemBatch.expiresAt),
                  gt(redeemBatch.expiresAt, now),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: redeemCode.id });
  return claimed.length > 0;
}

async function releaseUse(codeId: string): Promise<void> {
  try {
    await db
      .update(redeemCode)
      .set({
        // Never below zero, even if undo ever ran twice.
        redemptionCount: sql`greatest(${redeemCode.redemptionCount} - 1, 0)`,
      })
      .where(eq(redeemCode.id, codeId));
  } catch (error) {
    logCompensation("release use", error);
  }
}

async function removeRedemption(redemptionId: string): Promise<void> {
  try {
    await db
      .delete(redeemRedemption)
      .where(eq(redeemRedemption.id, redemptionId));
  } catch (error) {
    logCompensation("delete redemption", error);
  }
}

/** Undoes steps 3-4. */
async function undoClaim(codeId: string, redemptionId: string): Promise<void> {
  await removeRedemption(redemptionId);
  await releaseUse(codeId);
}

/**
 * Redeems a code for a user. Returns a typed outcome for every expected
 * failure; only unexpected errors (database down, ...) throw, after the claim
 * has been undone.
 */
export async function redeemCodeForUser(
  params: RedeemParams,
): Promise<RedeemResult> {
  const now = params.now ?? new Date();
  const { userId } = params;

  const { attemptId, throttled } = await recordAttempt(userId, params.ip, now);
  if (throttled) {
    return { ok: false, reason: "throttled" };
  }

  // Failures that reveal nothing about why: the attempt stays counted.
  const invalid = (): RedeemResult => ({ ok: false, reason: "invalid" });
  // Outcomes only reachable with a valid code: not a guess, so not counted.
  const specific = async (
    reason: Exclude<RedeemFailureReason, "invalid" | "throttled">,
  ): Promise<RedeemResult> => {
    await forgiveAttempt(attemptId);
    return { ok: false, reason };
  };

  const normalized = normalizeRedeemCode(params.input);
  if (!isWellFormedRedeemCode(normalized)) {
    return invalid();
  }

  const [found] = await db
    .select({ code: redeemCode, batch: redeemBatch })
    .from(redeemCode)
    .innerJoin(redeemBatch, eq(redeemBatch.id, redeemCode.batchId))
    .where(eq(redeemCode.codeHash, hashRedeemCode(normalized)));
  if (!found) {
    return invalid();
  }
  const { code, batch } = found;

  const [account] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId));
  if (!account || isBanned(account, now)) {
    return invalid();
  }

  // The user already holds this code: say so even if it is now used up.
  const [mine] = await db
    .select({ id: redeemRedemption.id })
    .from(redeemRedemption)
    .where(
      and(
        eq(redeemRedemption.codeId, code.id),
        eq(redeemRedemption.userId, userId),
      ),
    );
  if (mine) {
    return specific("already_redeemed");
  }

  if (!isCodeUsable(code, batch, now)) {
    return invalid();
  }

  const [usedInBatch] = await db
    .select({ total: count() })
    .from(redeemRedemption)
    .where(
      and(
        eq(redeemRedemption.batchId, batch.id),
        eq(redeemRedemption.userId, userId),
      ),
    );
  if (Number(usedInBatch?.total ?? 0) >= batch.perUserLimit) {
    return specific("user_limit");
  }

  const [planRow] = await db
    .select()
    .from(plan)
    .where(eq(plan.id, batch.planId));
  if (!planRow) {
    // plan_id is RESTRICT, so this is unreachable short of corruption.
    return invalid();
  }

  // Step 3: claim.
  if (!(await claimUse(code, batch, now))) {
    return invalid();
  }

  // Step 4: record the redemption.
  const redemptionId = randomUUID();
  try {
    await db.insert(redeemRedemption).values({
      id: redemptionId,
      codeId: code.id,
      batchId: batch.id,
      userId,
      createdAt: now,
    });
  } catch (error) {
    await releaseUse(code.id);
    if (isUniqueViolation(error)) {
      return specific("already_redeemed");
    }
    throw error;
  }

  // Step 5: verify the per-user limit now that our own row is visible.
  try {
    const [after] = await db
      .select({ total: count() })
      .from(redeemRedemption)
      .where(
        and(
          eq(redeemRedemption.batchId, batch.id),
          eq(redeemRedemption.userId, userId),
        ),
      );
    if (Number(after?.total ?? 0) > batch.perUserLimit) {
      await undoClaim(code.id, redemptionId);
      return specific("user_limit");
    }
  } catch (error) {
    await undoClaim(code.id, redemptionId);
    throw error;
  }

  // Step 6: grant through the gate-aware writers.
  const grantResult = await grantSubscription({
    userId,
    batch,
    plan: planRow,
    now,
  }).catch(async (error: unknown) => {
    await undoClaim(code.id, redemptionId);
    throw error;
  });

  // Step 7: bookkeeping. The grant has happened, so failures here are logged
  // rather than undone.
  try {
    await db
      .update(redeemRedemption)
      .set({ subscriptionId: grantResult.subscriptionId })
      .where(eq(redeemRedemption.id, redemptionId));
  } catch (error) {
    console.error("[redeem] could not link redemption to subscription", error);
  }
  await forgiveAttempt(attemptId);

  return {
    ok: true,
    planName: planRow.name,
    expiresAt: grantResult.expiresAt,
    action: grantResult.action,
  };
}

interface GrantParams {
  userId: string;
  batch: RedeemBatch;
  plan: typeof plan.$inferSelect;
  now: Date;
}

/**
 * Creates or extends the user's subscription via the shared gate-aware
 * writers (`insertSubscription` records the publish-gate `credential` change,
 * `applySubscriptionUpdate` the `authorization` change for an expiry move).
 * Cleans up after itself if the writers throw.
 */
async function grantSubscription(params: GrantParams): Promise<{
  subscriptionId: string;
  expiresAt: Date;
  action: "created" | "extended";
}> {
  const { userId, batch, plan: planRow, now } = params;

  const userSubscriptions = await db
    .select()
    .from(subscription)
    .where(
      and(eq(subscription.userId, userId), eq(subscription.planId, planRow.id)),
    );
  const grant = planRedeemGrant({
    mode: batch.mode,
    durationDays: batch.durationDays,
    plan: planRow,
    userSubscriptions,
    now,
  });

  if (grant.kind === "create") {
    // Pre-chosen id so a half-finished insert can be found and removed.
    const subscriptionId = randomUUID();
    try {
      const row = await insertSubscription({
        id: subscriptionId,
        userId,
        plan: planRow,
        startedAt: grant.startedAt,
        expiresAt: grant.expiresAt,
      });
      return {
        subscriptionId: row.id,
        expiresAt: row.expiresAt,
        action: "created",
      };
    } catch (error) {
      try {
        await db
          .delete(subscription)
          .where(eq(subscription.id, subscriptionId));
      } catch (cleanupError) {
        logCompensation("delete subscription", cleanupError);
      }
      throw error;
    }
  }

  const before = userSubscriptions.find(
    (sub) => sub.id === grant.subscriptionId,
  )!;
  try {
    const row = await applySubscriptionUpdate(before, grant.patch);
    return {
      subscriptionId: row.id,
      expiresAt: row.expiresAt,
      action: "extended",
    };
  } catch (error) {
    // The update may have landed before the gate record failed: put the
    // previous expiry and quota back (itself gate-aware) so a failed
    // redemption does not leave a free extension behind.
    try {
      const [current] = await db
        .select()
        .from(subscription)
        .where(eq(subscription.id, before.id));
      if (
        current &&
        current.expiresAt.getTime() === grant.patch.expiresAt.getTime()
      ) {
        await applySubscriptionUpdate(current, {
          expiresAt: before.expiresAt,
          trafficQuotaBytes: before.trafficQuotaBytes,
        });
      }
    } catch (restoreError) {
      logCompensation("restore extended subscription", restoreError);
    }
    throw error;
  }
}
