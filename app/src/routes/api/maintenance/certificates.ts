import { createFileRoute } from "@tanstack/react-router";

import { advanceCertificateIssuance } from "@/lib/certificate-issuance";
import { getServerEnv } from "@/lib/env";
import {
  authorizeMaintenanceRequest,
  NO_STORE_HEADERS,
} from "@/lib/maintenance-auth";

/**
 * Scheduler-only certificate sweep: advances ACME issuance and renewal for
 * every managed certificate, so renewals no longer depend on an agent
 * reconnecting or an admin mutation. The token is independent of user
 * sessions and the caller supplies no parameters.
 */
export interface CertificateMaintenanceDependencies {
  token(): string | undefined;
  advance(): Promise<void>;
}

const defaultDependencies: CertificateMaintenanceDependencies = {
  token: () => getServerEnv().MAINTENANCE_TOKEN,
  advance: () => advanceCertificateIssuance(),
};

export async function handleCertificateMaintenance(
  request: Request,
  dependencies: CertificateMaintenanceDependencies = defaultDependencies,
): Promise<Response> {
  const denied = authorizeMaintenanceRequest(request, dependencies.token());
  if (denied) {
    return denied;
  }

  try {
    await dependencies.advance();
    return Response.json({ advanced: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[maintenance/certificates] failed:", error);
    return Response.json(
      { error: "certificate_sweep_failed" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export const Route = createFileRoute("/api/maintenance/certificates")({
  server: {
    handlers: {
      POST: ({ request }) => handleCertificateMaintenance(request),
      // Vercel Cron sends GET; external schedulers may use either. The token
      // check is identical, and the work is bounded per invocation.
      GET: ({ request }) => handleCertificateMaintenance(request),
    },
  },
});
