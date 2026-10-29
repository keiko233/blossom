import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import {
  type AdminAuditAction,
  type AdminAuditMeta,
  buildAdminAuditRow,
} from "@/lib/admin-audit";
import { getClientIp } from "@/lib/client-ip";
import { getAdminSession } from "@/lib/ensure-admin";
import { appendAdminAudit } from "@/query/admin-audit-record";

/**
 * Function middleware that records an admin mutation in `admin_audit_log`:
 *
 *   createServerFn({ method: "POST" })
 *     .middleware([adminAudit("user.ban", { targetType: "user", targetId: fromInput("userId") })])
 *     .validator(...)
 *     .handler(...)
 *
 * It wraps the whole chain (validation included), so rejected input and
 * thrown errors are recorded as `error` entries and rethrown untouched.
 * Requests without an admin session are not recorded (the handler's own
 * `ensureAdmin` rejects them). A failing audit write is logged and ignored:
 * it never changes the mutation's result.
 *
 * Middleware runs before the server function's validator, so `data` here is
 * the raw client input; it is only redacted and stored, never trusted.
 */
export function adminAudit(action: AdminAuditAction, meta?: AdminAuditMeta) {
  return createMiddleware({ type: "function" }).server(
    async ({ data, next }) => {
      const startedAt = Date.now();

      let session: Awaited<ReturnType<typeof getAdminSession>> = null;
      try {
        session = await getAdminSession();
      } catch (error) {
        console.error(`[admin-audit] ${action}: session lookup failed`, error);
      }

      const record = async (outcome: {
        result?: unknown;
        error?: unknown;
        failed: boolean;
      }) => {
        if (!session) return;
        try {
          const request = getRequest();
          await appendAdminAudit(
            buildAdminAuditRow({
              id: crypto.randomUUID(),
              action,
              meta,
              input: data,
              ...outcome,
              actor: { id: session.user.id, email: session.user.email },
              impersonatedBy: session.session.impersonatedBy,
              ip: getClientIp(request),
              userAgent: request.headers.get("user-agent"),
              durationMs: Date.now() - startedAt,
            }),
          );
        } catch (auditError) {
          console.error(`[admin-audit] ${action}: write failed`, auditError);
        }
      };

      let outcome;
      try {
        outcome = await next();
      } catch (error) {
        await record({ error, failed: true });
        throw error;
      }
      await record({
        result: (outcome as { result?: unknown }).result,
        failed: false,
      });
      return outcome;
    },
  );
}
