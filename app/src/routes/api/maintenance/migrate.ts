import { createFileRoute } from "@tanstack/react-router";

import { getServerEnv } from "@/lib/env";
import {
  authorizeMaintenanceRequest,
  NO_STORE_HEADERS,
} from "@/lib/maintenance-auth";
import {
  runBundledMigrations,
  type RuntimeMigrationResult,
} from "@/lib/runtime-migrations";

export interface MigrateMaintenanceDependencies {
  token(): string | undefined;
  migrate(): Promise<RuntimeMigrationResult>;
}

const defaultDependencies: MigrateMaintenanceDependencies = {
  token: () => getServerEnv().MAINTENANCE_TOKEN,
  migrate: () => runBundledMigrations(),
};

/**
 * Deploy-hook entry point that applies bundled Drizzle SQL migrations through
 * the Worker's runtime database connection (e.g. Cloudflare Hyperdrive).
 */
export async function handleMigrateMaintenance(
  request: Request,
  dependencies: MigrateMaintenanceDependencies = defaultDependencies,
): Promise<Response> {
  const denied = authorizeMaintenanceRequest(request, dependencies.token());
  if (denied) {
    return denied;
  }

  try {
    const result = await dependencies.migrate();
    return Response.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[maintenance/migrate] failed:", error);
    return Response.json(
      { error: "migration_failed" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export const Route = createFileRoute("/api/maintenance/migrate")({
  server: {
    handlers: {
      POST: ({ request }) => handleMigrateMaintenance(request),
    },
  },
});
