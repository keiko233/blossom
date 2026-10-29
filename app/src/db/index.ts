import { createDatabaseManager } from "@blossom/database/server";

import {
  getDatabaseRequest,
  getHyperdriveConnectionString,
} from "@/lib/database-connection";
import { getServerEnv } from "@/lib/env";

export type { Database } from "@blossom/database/server";

const manager = createDatabaseManager({
  getRequest: getDatabaseRequest,
  getConfig: () => {
    const env = getServerEnv();
    return {
      databaseUrl: env.DATABASE_URL,
      configuredDriver: env.DATABASE_DRIVER,
      hyperdriveConnectionString: getHyperdriveConnectionString(),
    };
  },
});

export const { db, getDatabaseDriver } = manager;
