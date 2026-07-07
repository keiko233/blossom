import {
  drizzle as drizzleNeonHttp,
  type NeonHttpDatabase,
} from "drizzle-orm/neon-http";
import {
  drizzle as drizzleNodePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";

import { getServerEnv } from "@/lib/env";
import { DatabaseDriver } from "@/lib/env-schema";

const serverEnv = getServerEnv();

export { DatabaseDriver };

const resolveDriver = (): DatabaseDriver => {
  if (serverEnv.DATABASE_DRIVER) {
    return serverEnv.DATABASE_DRIVER;
  }

  return serverEnv.DATABASE_URL.includes(".neon.tech")
    ? DatabaseDriver.NeonHttp
    : DatabaseDriver.NodePg;
};

export type Database = NeonHttpDatabase | NodePgDatabase;

export const db: Database =
  resolveDriver() === DatabaseDriver.NeonHttp
    ? drizzleNeonHttp(serverEnv.DATABASE_URL)
    : drizzleNodePg(serverEnv.DATABASE_URL);
