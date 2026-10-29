import {
  drizzle as drizzleNeonHttp,
  type NeonHttpDatabase,
} from "drizzle-orm/neon-http";
import {
  drizzle as drizzleNodePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";

import { DatabaseDriver, resolveDatabaseConfig } from "./driver";

export type Database = NeonHttpDatabase | NodePgDatabase;

type DatabaseConfig = Parameters<typeof resolveDatabaseConfig>[0];

/** Request must be supplied on runtimes whose database sockets are request-bound. */
export function createDatabaseManager(options: {
  getRequest: () => Request | undefined;
  getConfig: () => DatabaseConfig;
}) {
  function createDatabase() {
    const config = resolveDatabaseConfig(options.getConfig());
    const db: Database =
      config.driver === DatabaseDriver.NeonHttp
        ? drizzleNeonHttp(config.connectionString)
        : drizzleNodePg(config.connectionString);
    return { db, driver: config.driver };
  }
  type Instance = ReturnType<typeof createDatabase>;
  const requests = new WeakMap<Request, Instance>();
  let shared: Instance | undefined;
  function current(): Instance {
    const request = options.getRequest();
    if (!request) return (shared ??= createDatabase());
    let instance = requests.get(request);
    if (!instance) {
      instance = createDatabase();
      requests.set(request, instance);
    }
    return instance;
  }
  const db: Database = new Proxy({} as Database, {
    get(_target, key) {
      const database = current().db;
      const value = Reflect.get(database, key, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  });
  return { db, getDatabaseDriver: () => current().driver };
}
