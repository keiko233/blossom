import { NoUsableProxiesError } from "./clash-config";

/**
 * Why a subscription fetch that passed authentication produced no config.
 * Internal vocabulary: the response body carries only a short fixed message,
 * never node names, protocols or settings.
 *
 *  - `no_nodes`            – no enabled node/server is reachable through the
 *                            subscription's plan groups. Needs an admin.
 *  - `pending_deployment`  – nodes exist, but the publish gate withheld them
 *                            until their servers' agents confirm the change.
 *                            The only reason a retry can fix.
 *  - `unsupported_nodes`   – every visible node is unrepresentable in Clash.
 *                            Permanent until a node is edited.
 *  - `generation_failed`   – anything else thrown while building: a bug.
 */
export type DeliveryFailureReason =
  | "no_nodes"
  | "pending_deployment"
  | "unsupported_nodes"
  | "generation_failed";

export interface DeliveryFailure {
  reason: DeliveryFailureReason;
  status: number;
  /** Only set when waiting can actually help. */
  retryAfterSeconds?: number;
  body: string;
}

export const PENDING_RETRY_AFTER_SECONDS = 30;

/**
 * Maps a failed build to its reason and HTTP shape.
 *
 * `accessibleCount` is the number of nodes the subscription may use before
 * the publish gate; `gatedCount` the number the gate let through. Status
 * choices: 403 keeps "nothing entitled" indistinguishable in kind from the
 * other refusals; 422 marks a well-formed request the server cannot satisfy;
 * 503 + Retry-After is reserved for the gate; 500 for bugs.
 */
export function classifyDeliveryFailure(input: {
  accessibleCount: number;
  gatedCount: number;
  error: unknown;
}): DeliveryFailure {
  const { accessibleCount, gatedCount, error } = input;
  if (!(error instanceof NoUsableProxiesError)) {
    return {
      reason: "generation_failed",
      status: 500,
      body: "Internal Server Error",
    };
  }
  if (accessibleCount === 0) {
    return {
      reason: "no_nodes",
      status: 403,
      body: "No nodes are available for this subscription",
    };
  }
  // Anything the gate withheld may become servable once agents catch up, even
  // if what remained visible is unsupported.
  if (gatedCount < accessibleCount) {
    return {
      reason: "pending_deployment",
      status: 503,
      retryAfterSeconds: PENDING_RETRY_AFTER_SECONDS,
      body: "Configuration is being deployed",
    };
  }
  return {
    reason: "unsupported_nodes",
    status: 422,
    body: "No node in this subscription is compatible with this client format",
  };
}

export function deliveryFailureResponse(failure: DeliveryFailure): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (failure.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(failure.retryAfterSeconds);
  }
  return new Response(failure.body, { status: failure.status, headers });
}
