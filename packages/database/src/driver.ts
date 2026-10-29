export const DatabaseDriver = {
  NeonHttp: "neon-http",
  NodePg: "node-postgres",
} as const;
export type DatabaseDriver =
  (typeof DatabaseDriver)[keyof typeof DatabaseDriver];

export function supportsInteractiveTransactions(
  driver: DatabaseDriver,
): boolean {
  return driver === DatabaseDriver.NodePg;
}

export function resolveDatabaseConfig(options: {
  databaseUrl: string;
  configuredDriver?: DatabaseDriver;
  hyperdriveConnectionString?: string;
}): { connectionString: string; driver: DatabaseDriver } {
  if (options.hyperdriveConnectionString) {
    return {
      connectionString: options.hyperdriveConnectionString,
      driver: DatabaseDriver.NodePg,
    };
  }
  return {
    connectionString: options.databaseUrl,
    driver:
      options.configuredDriver ??
      (options.databaseUrl.includes(".neon.tech")
        ? DatabaseDriver.NeonHttp
        : DatabaseDriver.NodePg),
  };
}
