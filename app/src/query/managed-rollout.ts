import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { fromInput } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import { dispatchManagedRolloutThroughHub } from "@/lib/managed-rollout-dispatch";
import type { ManagedRolloutDispatchResult } from "@/lib/managed-rollout-runtime";
import {
  abortManagedRolloutAndNotify,
  retryManagedRolloutAndNotify,
} from "@/lib/managed-rollout-runtime";
import {
  listManagedRolloutDetails,
  readManagedRolloutDetail,
  type ManagedRolloutAbortResult,
  type ManagedRolloutDetail,
  type ManagedRolloutRetryResult,
} from "@/query/managed-rollout-write";

/**
 * Typed admin read/action surface for Task 09. The networking workspace owns
 * presentation; this module owns the authenticated, audited boundary and
 * returns the persisted view plus the post-commit delivery result. Every
 * action is idempotent at the rollout CAS, so a repeated click never advances
 * a second stage.
 */

export const managedRolloutIdSchema = z.object({
  rolloutId: z.string().min(1).max(128),
});

export const managedRolloutListSchema = z
  .object({
    serverId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .optional();

export interface ManagedRolloutActionResponse<T> {
  result: T;
  delivery: ManagedRolloutDispatchResult;
}

export type ManagedRolloutListResponse = ManagedRolloutDetail[];

export const listManagedRollouts = createServerFn({ method: "GET" })
  .validator(managedRolloutListSchema)
  .handler(async ({ data }): Promise<ManagedRolloutListResponse> => {
    await ensureAdmin();
    return listManagedRolloutDetails(data ?? {});
  });

export const getManagedRollout = createServerFn({ method: "GET" })
  .validator(managedRolloutIdSchema)
  .handler(async ({ data }): Promise<ManagedRolloutDetail | null> => {
    await ensureAdmin();
    return readManagedRolloutDetail(data.rolloutId);
  });

export const retryManagedRollout = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("managed.rollout_retry", {
      targetType: "managed_rollout",
      targetId: fromInput("rolloutId"),
    }),
  ])
  .validator(managedRolloutIdSchema)
  .handler(
    async ({
      data,
    }): Promise<ManagedRolloutActionResponse<ManagedRolloutRetryResult>> => {
      await ensureAdmin();
      const { result, followUps } = await retryManagedRolloutAndNotify(
        data.rolloutId,
      );
      const delivery = await dispatchManagedRolloutThroughHub(followUps);
      return { result, delivery };
    },
  );

export const abortManagedRollout = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("managed.rollout_abort", {
      targetType: "managed_rollout",
      targetId: fromInput("rolloutId"),
    }),
  ])
  .validator(managedRolloutIdSchema)
  .handler(
    async ({
      data,
    }): Promise<ManagedRolloutActionResponse<ManagedRolloutAbortResult>> => {
      await ensureAdmin();
      const { result, followUps } = await abortManagedRolloutAndNotify(
        data.rolloutId,
      );
      const delivery = await dispatchManagedRolloutThroughHub(followUps);
      return { result, delivery };
    },
  );
