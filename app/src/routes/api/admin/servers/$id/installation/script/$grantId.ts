import { createFileRoute } from "@tanstack/react-router";

import { handleAdminInstallerDownload } from "@/lib/admin-installer-route";
import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute(
  "/api/admin/servers/$id/installation/script/$grantId",
)({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAdminInstallerDownload(
          request,
          { serverId: params.id, grantId: params.grantId },
          {
            publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
          },
        ),
    },
  },
});
