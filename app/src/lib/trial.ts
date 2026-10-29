import type { TrialSettings } from "./settings";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Id of the one trial subscription a user can ever receive. Deterministic so
 * that the primary key itself refuses a second grant, however the creation
 * hook is retried or raced.
 */
export function trialSubscriptionId(userId: string): string {
  return `trial_${userId}`;
}

/**
 * Whether an account creation earns the trial: trials are on, a plan is set,
 * and the account came from self-service sign-up. Admin-created accounts get
 * nothing automatically (the create-user dialog can assign a plan explicitly).
 */
export function shouldGrantTrial(
  trial: Pick<TrialSettings, "enabled" | "planId">,
  method: string,
): boolean {
  return trial.enabled && trial.planId !== null && method !== "admin";
}

/** Subscription period for a trial of `plan`, honouring the duration override. */
export function planTrialPeriod(
  trial: Pick<TrialSettings, "durationDays">,
  plan: { durationDays: number },
  now: Date,
): { startedAt: Date; expiresAt: Date; durationDays: number } {
  const durationDays = trial.durationDays ?? plan.durationDays;
  return {
    startedAt: now,
    expiresAt: new Date(now.getTime() + durationDays * MS_PER_DAY),
    durationDays,
  };
}
