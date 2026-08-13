import {
  drizzle as drizzleNeonHttp,
  type NeonHttpDatabase,
} from "drizzle-orm/neon-http";
import {
  drizzle as drizzleNodePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";

import { getHyperdriveConnectionString } from "@/lib/database-connection";
import { getServerEnv } from "@/lib/env";
import { DatabaseDriver } from "@/lib/env-schema";

import { resolveDatabaseConfig } from "./config";

const serverEnv = getServerEnv();

export { DatabaseDriver };

export type Database = NeonHttpDatabase | NodePgDatabase;

const databaseConfig = resolveDatabaseConfig({
  databaseUrl: serverEnv.DATABASE_URL,
  configuredDriver: serverEnv.DATABASE_DRIVER,
  hyperdriveConnectionString: getHyperdriveConnectionString(),
});

export const databaseDriver = databaseConfig.driver;

export const db: Database =
  databaseDriver === DatabaseDriver.NeonHttp
    ? drizzleNeonHttp(databaseConfig.connectionString)
    : drizzleNodePg(databaseConfig.connectionString);
