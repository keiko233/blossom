export interface BulkUserPlan {
  /** Ids to run the action on, deduplicated, in request order. */
  targets: string[];
  /** Ids left out because they are the calling admin's own account. */
  skipped: string[];
}

/**
 * Splits a bulk request into the ids to act on and the ones to skip. The
 * calling admin is always skipped: a bulk ban, demotion or delete must never
 * lock the caller out, and the single-user paths refuse self-targeting anyway.
 */
export function planUserBulk(
  ids: readonly string[],
  callerId: string,
): BulkUserPlan {
  const targets: string[] = [];
  const skipped: string[] = [];
  for (const id of new Set(ids)) {
    (id === callerId ? skipped : targets).push(id);
  }
  return { targets, skipped };
}
