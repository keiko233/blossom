import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";

export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
  {
    server: {
      handlers: {
        GET: async () => {
          const auth = getAuth();
          const env = getServerEnv();
          const handler = oauthProviderAuthServerMetadata(auth, {
            headers: {
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=3600",
            },
          });
          return handler(
            new Request(
              `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
            ),
          );
        },
        OPTIONS: async () =>
          new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Origin": "*",
            },
          }),
      },
    },
  },
);
