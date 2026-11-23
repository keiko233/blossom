import { createFileRoute } from "@tanstack/react-router";

import { db } from "@/db";
import { handleAgentGhcrV2 } from "@/lib/agent-ghcr-proxy";
import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute("/v2/$")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAgentGhcrV2(request, params._splat ?? "", {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
      HEAD: ({ params, request }) =>
        handleAgentGhcrV2(request, params._splat ?? "", {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
    },
  },
});
