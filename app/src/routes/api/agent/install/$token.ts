import { createFileRoute } from "@tanstack/react-router";

import { db } from "@/db";
import { handleAgentBootstrap } from "@/lib/agent-bootstrap-route";
import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute("/api/agent/install/$token")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAgentBootstrap(request, params.token, {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
    },
  },
});
