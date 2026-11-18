import { createFileRoute } from "@tanstack/react-router";

import { handleAgentWsRequest } from "@/lib/agent-ws-route";

export const Route = createFileRoute("/api/agent/ws")({
  server: {
    handlers: {
      GET: ({ request }) => handleAgentWsRequest(request),
    },
  },
});
