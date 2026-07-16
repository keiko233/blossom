import { createFileRoute } from "@tanstack/react-router";
import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";

import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const env = getServerEnv();
        const origin = env.BETTER_AUTH_URL.replace(/\/$/, "");

        const handler = protectedResourceHandler({
          authServerUrls: [`${origin}/api/auth`],
          resourceUrl: `${origin}/api/mcp`,
        });

        return handler(request);
      },
      OPTIONS: async () => metadataCorsOptionsRequestHandler()(),
    },
  },
});
