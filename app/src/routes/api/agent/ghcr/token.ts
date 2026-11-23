import { createFileRoute } from "@tanstack/react-router";

import { db } from "@/db";
import { handleAgentGhcrToken } from "@/lib/agent-ghcr-proxy";
import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute("/api/agent/ghcr/token")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAgentGhcrToken(request, {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
      POST: ({ request }) =>
        handleAgentGhcrToken(request, {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
    },
  },
});
