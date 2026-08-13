import { DatabaseDriver } from "@/lib/env-schema";

interface ResolveDatabaseConfigOptions {
  databaseUrl: string;
  configuredDriver?: DatabaseDriver;
  hyperdriveConnectionString?: string;
}

interface DatabaseConfig {
  connectionString: string;
  driver: DatabaseDriver;
}

export const resolveDatabaseConfig = ({
  databaseUrl,
  configuredDriver,
  hyperdriveConnectionString,
}: ResolveDatabaseConfigOptions): DatabaseConfig => {
  if (hyperdriveConnectionString) {
    return {
      connectionString: hyperdriveConnectionString,
      driver: DatabaseDriver.NodePg,
    };
  }

  return {
    connectionString: databaseUrl,
    driver:
      configuredDriver ??
      (databaseUrl.includes(".neon.tech")
        ? DatabaseDriver.NeonHttp
        : DatabaseDriver.NodePg),
  };
};
