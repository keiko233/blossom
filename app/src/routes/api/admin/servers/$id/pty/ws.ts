import { createFileRoute } from "@tanstack/react-router";

import { handleAdminPtyRequest } from "@/lib/admin-pty-route";

export const Route = createFileRoute("/api/admin/servers/$id/pty/ws")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAdminPtyRequest(request, { serverId: params.id }),
    },
  },
});
