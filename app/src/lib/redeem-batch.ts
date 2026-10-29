/**
 * Pure rules for redeem batches. Client-safe: no Drizzle, no Node imports.
 */

export const REDEEM_MODES = ["new", "extend"] as const;
export type RedeemMode = (typeof REDEEM_MODES)[number];

/** Effective batch states, in the order the filter offers them. */
export const REDEEM_BATCH_STATUSES = [
  "active",
  "disabled",
  "expired",
  "exhausted",
] as const;
export type RedeemBatchStatus = (typeof REDEEM_BATCH_STATUSES)[number];

/** Codes one create / add-codes request may generate. */
export const REDEEM_CODES_PER_REQUEST_MAX = 1000;
/** Codes one batch may hold in total. */
export const REDEEM_CODES_PER_BATCH_MAX = 10_000;

export interface RedeemBatchStatusInput {
  disabled: boolean;
  expiresAt: Date | null;
  codeCount: number;
  /** Sum of every code's `redemptionCount`. */
  redeemed: number;
  maxRedemptionsPerCode: number;
}

/**
 * Effective state: a disabled batch is `disabled` whatever its dates say;
 * otherwise a passed expiry is `expired`; otherwise a batch whose every use is
 * taken is `exhausted`. `expiresAt` is exclusive (codes stop working at it).
 */
export function getRedeemBatchStatus(
  batch: RedeemBatchStatusInput,
  now: Date,
): RedeemBatchStatus {
  if (batch.disabled) return "disabled";
  if (batch.expiresAt && batch.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (
    batch.codeCount > 0 &&
    batch.redeemed >=
      totalRedeemUses(batch.codeCount, batch.maxRedemptionsPerCode)
  ) {
    return "exhausted";
  }
  return "active";
}

/** Total uses a batch offers: codes x uses per code. */
export function totalRedeemUses(
  codeCount: number,
  maxRedemptionsPerCode: number,
): number {
  return codeCount * maxRedemptionsPerCode;
}

/** The duration a batch grants: its override, else the plan's. */
export function resolveRedeemDurationDays(
  batch: { durationDays: number | null },
  plan: { durationDays: number },
): number {
  return batch.durationDays ?? plan.durationDays;
}

/**
 * Outcome of a user redeeming a code. `invalid` is deliberately the single
 * answer for every failed check on the code (unknown, malformed, disabled,
 * expired, used up, banned account) so attempts learn nothing about which
 * check failed; `already_redeemed` and `user_limit` only occur for a code that
 * is otherwise valid.
 */
export type RedeemFailureReason =
  | "invalid"
  | "throttled"
  | "already_redeemed"
  | "user_limit";

export type RedeemResult =
  | {
      ok: true;
      planName: string;
      expiresAt: Date;
      /** Whether a new subscription was created or an existing one extended. */
      action: "created" | "extended";
    }
  | { ok: false; reason: RedeemFailureReason };

/** Whole number in [min, max] parsed from form text, or null. */
export function parseIntInRange(
  value: string,
  min: number,
  max: number,
): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}
