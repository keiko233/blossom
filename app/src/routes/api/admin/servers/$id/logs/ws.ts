import { createFileRoute } from "@tanstack/react-router";

import { handleAdminLogsRequest } from "@/lib/admin-logs-route";

export const Route = createFileRoute("/api/admin/servers/$id/logs/ws")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAdminLogsRequest(request, { serverId: params.id }),
    },
  },
});
