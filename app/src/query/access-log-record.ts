import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { accessLog, type NewAccessLog } from "@/db/access-log-schema";

/**
 * Persists an access-log row. Kept separate from the client-facing access-log
 * server functions so importing those helpers never drags this direct database
 * writer into the browser bundle.
 */
export async function recordAccessLog(
  entry: Omit<NewAccessLog, "id">,
): Promise<void> {
  await db.insert(accessLog).values({
    id: randomUUID(),
    ...entry,
  });
}
