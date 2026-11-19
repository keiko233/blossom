import { createFileRoute } from "@tanstack/react-router";

import { handleAdminPtyStatus } from "@/lib/admin-pty-route";

export const Route = createFileRoute("/api/admin/servers/$id/pty/status")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAdminPtyStatus(request, { serverId: params.id }),
    },
  },
});
