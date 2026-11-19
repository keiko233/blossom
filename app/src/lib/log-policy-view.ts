import {
  isLogPolicyTemporaryLevel,
  type LogPolicyLevel,
} from "@blossom/contracts/log-policy";

import type { ServerLogPolicySourceView } from "@/query/log-policy";

/**
 * Stable per-source states for the log-policy controls. The component turns
 * each cue into localized copy; several can apply at once, for example an
 * offline agent with an error from its last apply.
 */
export type LogPolicyCue =
  | "unsupported"
  | "disabled"
  | "offline"
  | "pending"
  | "applying"
  | "error"
  | "not-reported"
  | "in-sync";

export interface LogPolicyCueInput {
  view: ServerLogPolicySourceView;
  capability: boolean;
  enabled: boolean;
  offline: boolean;
}

export function logPolicyCues(input: LogPolicyCueInput): LogPolicyCue[] {
  const cues: LogPolicyCue[] = [];
  if (!input.capability) {
    cues.push("unsupported");
  }
  if (!input.enabled) {
    cues.push("disabled");
  }
  if (input.offline) {
    cues.push("offline");
  }
  if (input.view.pending) {
    cues.push("pending");
  }
  if (input.view.effectivePending) {
    cues.push("applying");
  }
  if (input.view.effectiveError) {
    cues.push("error");
  }
  if (input.view.effectiveRevision === null) {
    cues.push("not-reported");
  } else if (
    !input.view.pending &&
    !input.view.effectivePending &&
    !input.view.effectiveError
  ) {
    cues.push("in-sync");
  }
  return cues;
}

/** A temporary request exists until Restore now clears it, even after expiry. */
export function hasTemporaryLogPolicyRequest(
  view: ServerLogPolicySourceView,
): boolean {
  return view.expired || isLogPolicyTemporaryLevel(view.desiredLevel);
}

/** Whether the selected level persists as a baseline instead of an override. */
export function isLogPolicyBaselineLevel(
  level: LogPolicyLevel,
): level is Exclude<LogPolicyLevel, "debug" | "trace"> {
  return !isLogPolicyTemporaryLevel(level);
}

/**
 * Converts the minutes field to the seconds accepted by the server. The UI
 * bounds are 0.5 to 60 minutes, which stay inside the contract's 30 to 3600
 * second range. Returns `null` for an invalid draft.
 */
export function temporarySecondsFromMinutes(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > 60) {
    return null;
  }
  return Math.round(minutes * 60);
}
