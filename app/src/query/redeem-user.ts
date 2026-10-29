import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { ensureSession } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import type { RedeemResult } from "@/lib/redeem-batch";
import { redeemCodeInputSchema } from "@/orpc/redeem/schema";
import { redeemCodeForUser } from "@/query/redeem-service";

/**
 * Redeems a code for the signed-in user. This is a user action, not an admin
 * one: it is NOT wrapped in `adminAudit` (and is listed in the audit test's
 * `USER_FACING_POST_FNS`). The user comes from the session only.
 *
 * Expected failures come back as `{ ok: false, reason }` so the client can
 * show a localized message; every failed check on the code itself is the same
 * `invalid` reason. See `@/query/redeem-service` for the algorithm.
 */
export const redeemCode = createServerFn({ method: "POST" })
  .validator(redeemCodeInputSchema)
  .handler(async ({ data }): Promise<RedeemResult> => {
    const session = await ensureSession();
    return redeemCodeForUser({
      userId: session.user.id,
      input: data.code,
      ip: getClientIp(getRequest()),
    });
  });
