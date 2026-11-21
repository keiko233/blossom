import { createDatabaseManager } from "@blossom/database/server";

import {
  getDatabaseRequest,
  getFreshHyperdriveConnectionString,
  getHyperdriveConnectionString,
} from "@/lib/database-connection";
import { getServerEnv } from "@/lib/env";

export type { Database } from "@blossom/database/server";

function buildConfig(hyperdriveConnectionString: string | undefined) {
  const env = getServerEnv();
  return {
    databaseUrl: env.DATABASE_URL,
    configuredDriver: env.DATABASE_DRIVER,
    hyperdriveConnectionString,
  };
}

/**
 * Default database handle: prefers `HYPERDRIVE_FRESH` (caching disabled) so
 * writes, auth checks, and read-after-write queries are never served stale
 * cache entries. Falls back to `HYPERDRIVE` or `DATABASE_URL` when unconfigured.
 */
const freshManager = createDatabaseManager({
  getRequest: getDatabaseRequest,
  getConfig: () => buildConfig(getFreshHyperdriveConnectionString()),
});

/**
 * Opt-in cached database handle backed by `HYPERDRIVE` (edge query caching
 * enabled). Use only for read-heavy queries that can tolerate brief staleness.
 */
const cachedManager = createDatabaseManager({
  getRequest: getDatabaseRequest,
  getConfig: () => buildConfig(getHyperdriveConnectionString()),
});

export const { db, getDatabaseDriver } = freshManager;
export const dbCached = cachedManager.db;
