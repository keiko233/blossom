import { createFileRoute } from "@tanstack/react-router";

import { db } from "@/db";
import { handleEnrollmentRedeem } from "@/lib/agent-enrollment-route";
import { getServerEnv } from "@/lib/env";
import { getOAuthResourceIdentifiers } from "@/lib/oauth-provider-config";

export const Route = createFileRoute("/api/agent/enrollment/redeem")({
  server: {
    handlers: {
      POST: ({ request }) => {
        const origin = getServerEnv().BETTER_AUTH_URL.replace(/\/$/, "");
        return handleEnrollmentRedeem(request, {
          db,
          origin,
          resources: getOAuthResourceIdentifiers(origin),
        });
      },
    },
  },
});
