import { createFileRoute } from "@tanstack/react-router";

import { handleAdminMetricsRequest } from "@/lib/admin-metrics-route";

export const Route = createFileRoute("/api/admin/servers/$id/metrics/ws")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAdminMetricsRequest(request, { serverId: params.id }),
    },
  },
});
