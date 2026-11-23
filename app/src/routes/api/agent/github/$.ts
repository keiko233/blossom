import { createFileRoute } from "@tanstack/react-router";

import { db } from "@/db";
import { handleAgentGithubProxy } from "@/lib/agent-github-proxy";
import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute("/api/agent/github/$")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAgentGithubProxy(request, params._splat ?? "", {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
      HEAD: ({ params, request }) =>
        handleAgentGithubProxy(request, params._splat ?? "", {
          db,
          publicOrigin: getServerEnv().BETTER_AUTH_URL.replace(/\/$/, ""),
        }),
    },
  },
});
