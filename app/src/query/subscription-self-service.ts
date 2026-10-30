import { subscriptionIdSchema } from "@blossom/contracts/plan";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { subscription } from "@/db/plan-schema";
import { ensureSession } from "@/lib/auth";
import {
  listPendingConfigChanges,
  listServerIdsForSubscriptionId,
} from "@/query/config-change";
import {
  rotateSubscriptionCredentials,
  rotateSubscriptionToken,
} from "@/query/subscription-write";

/**
 * Owner self-service for leaked subscription links and proxy credentials.
 *
 * These are user actions, not admin ones: they are NOT wrapped in `adminAudit`
 * (see `USER_FACING_POST_FNS` in the audit test). The owner is taken from the
 * session only; the input carries just the subscription id, and a subscription
 * that belongs to someone else fails exactly like a missing one ("Not found").
 * The rotation logic is the same code the admin actions run
 * (`@/query/subscription-write`).
 *
 * Results never contain the proxy credentials. `rotateOwnSubscriptionToken`
 * returns the new link token because the owner needs it to build the new URL
 * (the dashboard query already exposes the token to the owner); treat it as a
 * secret: do not log it or send it to analytics.
 */

/** Servers that still have to apply a credential rotation. */
export interface CredentialApplyState {
  id: string;
  /**
   * Servers whose agent has not yet confirmed the rotated credentials. While
   * this is above zero the subscription keeps emitting the previous
   * credentials for nodes on those servers, and the previous credentials keep
   * authenticating there. Zero means the rotation is fully in effect.
   */
  pendingServerCount: number;
}

/**
 * Rotates the subscription link token.
 *
 * Old URL: stops working immediately (the next fetch of it is rejected).
 * Proxy credentials: unchanged. Clients that already imported the config keep
 * connecting with the same credentials, so this does NOT cut off someone who
 * already copied the config; use `rotateOwnSubscriptionCredentials` for that.
 * No agent action is needed and nothing is recorded in the publish gate.
 */
export const rotateOwnSubscriptionToken = createServerFn({ method: "POST" })
  .validator(subscriptionIdSchema)
  .handler(async ({ data }): Promise<{ id: string; token: string }> => {
    const session = await ensureSession();
    const row = await rotateSubscriptionToken(data.id, {
      ownerUserId: session.user.id,
    });
    return { id: row.id, token: row.token };
  });

/**
 * Rotates the proxy credentials (uuid + password).
 *
 * The subscription URL is unchanged and keeps working. The new credentials
 * propagate through the publish gate: each affected server must apply the
 * revision first. Until a server has done so, the subscription keeps emitting
 * the previous credentials for its nodes and those still authenticate; once it
 * has, the previous credentials are rejected there. The result reports how
 * many servers are pending, and `getOwnCredentialApplyState` can be polled for
 * progress. Clients must refresh the subscription after the servers apply.
 */
export const rotateOwnSubscriptionCredentials = createServerFn({
  method: "POST",
})
  .validator(subscriptionIdSchema)
  .handler(async ({ data }): Promise<CredentialApplyState> => {
    const session = await ensureSession();
    const { row, serverIds } = await rotateSubscriptionCredentials(data.id, {
      ownerUserId: session.user.id,
    });
    // A rotation was just recorded against each of these servers and none has
    // applied it yet, so all of them are pending.
    return { id: row.id, pendingServerCount: new Set(serverIds).size };
  });

/**
 * How many servers still have to apply this subscription's latest credential
 * rotation. Read-only; owner-only like the rotations.
 */
export const getOwnCredentialApplyState = createServerFn({ method: "GET" })
  .validator(subscriptionIdSchema)
  .handler(async ({ data }): Promise<CredentialApplyState> => {
    const session = await ensureSession();
    const [owned] = await db
      .select({ id: subscription.id })
      .from(subscription)
      .where(
        and(
          eq(subscription.id, data.id),
          eq(subscription.userId, session.user.id),
        ),
      );
    if (!owned) {
      throw new Error("Not found");
    }
    const pending = await listPendingConfigChanges(
      await listServerIdsForSubscriptionId(db, owned.id),
    );
    const pendingServers = new Set(
      pending
        .filter((c) => c.kind === "credential" && c.subjectId === owned.id)
        .map((c) => c.serverId),
    );
    return { id: owned.id, pendingServerCount: pendingServers.size };
  });
