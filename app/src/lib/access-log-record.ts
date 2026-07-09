import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { accessLog, type NewAccessLog } from "@/db/access-log-schema";

/**
 * Persists an access-log row. Kept separate from the query module and from
 * client-facing files so importing the query helpers never drags the database
 * driver into the browser bundle.
 */
export async function recordAccessLog(
  entry: Omit<NewAccessLog, "id">,
): Promise<void> {
  await db.insert(accessLog).values({
    id: randomUUID(),
    ...entry,
  });
}
