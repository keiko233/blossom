import { db } from "@/db";
import { adminAuditLog, type NewAdminAuditLog } from "@/db/admin-audit-schema";

/**
 * Appends one audit row. Callers are the audit middleware, which swallows
 * failures so a broken audit table can never fail the audited mutation.
 */
export async function appendAdminAudit(row: NewAdminAuditLog): Promise<void> {
  await db.insert(adminAuditLog).values(row);
}
