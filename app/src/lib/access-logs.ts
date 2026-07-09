import { createServerFn } from "@tanstack/react-start";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { accessLog, type AccessLogSubjectType } from "@/db/access-log-schema";
import { ensureAdmin } from "@/lib/ensure-admin";

export const ACCESS_LOGS_QUERY_KEY = ["admin", "access-logs"] as const;

const listAccessLogsSchema = z.object({
  subjectType: z.string(),
  subjectId: z.string(),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

export interface AccessLogListResult {
  rows: (typeof accessLog.$inferSelect)[];
  total: number;
}

export const listAccessLogs = createServerFn({ method: "GET" })
  .validator(listAccessLogsSchema)
  .handler(async ({ data }): Promise<AccessLogListResult> => {
    await ensureAdmin();

    const where = and(
      eq(accessLog.subjectType, data.subjectType as AccessLogSubjectType),
      eq(accessLog.subjectId, data.subjectId),
    );

    const [rows, [{ value }]] = await Promise.all([
      db
        .select()
        .from(accessLog)
        .where(where)
        .orderBy(desc(accessLog.createdAt))
        .limit(data.limit)
        .offset(data.cursor),
      db.select({ value: count() }).from(accessLog).where(where),
    ]);

    return { rows, total: value };
  });
