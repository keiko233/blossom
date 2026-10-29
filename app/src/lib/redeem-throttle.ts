/**
 * Brute-force throttling of redeem attempts. Failed attempts are persisted in
 * `redeem_attempt`; this module holds the policy, the query layer does the
 * counting. Client-safe.
 */

/** Sliding window failed attempts are counted over. */
export const REDEEM_THROTTLE_WINDOW_MS = 60 * 60 * 1000;
/** Failed attempts one account may make per window. */
export const REDEEM_USER_ATTEMPT_LIMIT = 10;
/**
 * Failed attempts one IP may make per window, across accounts. Higher than the
 * per-user limit because an IP can be a shared NAT or campus gateway.
 */
export const REDEEM_IP_ATTEMPT_LIMIT = 30;
/** Rows older than this are deleted opportunistically. */
export const REDEEM_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

export function throttleWindowStart(now: Date): Date {
  return new Date(now.getTime() - REDEEM_THROTTLE_WINDOW_MS);
}

export function attemptRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - REDEEM_ATTEMPT_RETENTION_MS);
}

export interface RedeemAttemptCounts {
  /** Attempts by this user inside the window, including the current one. */
  user: number;
  /** Attempts from this IP inside the window, including the current one; null if the IP is unknown. */
  ip: number | null;
}

/**
 * Whether an attempt is over budget. The current attempt is already counted
 * (it is recorded before checking, so concurrent guesses see each other), so
 * the limit itself is still allowed and the next one is not.
 */
export function isRedeemThrottled(counts: RedeemAttemptCounts): boolean {
  return (
    counts.user > REDEEM_USER_ATTEMPT_LIMIT ||
    (counts.ip !== null && counts.ip > REDEEM_IP_ATTEMPT_LIMIT)
  );
}
