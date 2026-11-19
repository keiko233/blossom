import { createFileRoute } from "@tanstack/react-router";

import { db } from "@/db";
import { getAuth } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";
import { getOAuthResourceIdentifiers } from "@/lib/oauth-provider-config";
import { ensureMcpResourceLinks } from "@/lib/oauth-resource-links";

// Legacy MCP clients must be linked to the MCP resource before the provider
// can serve them under per-client resource enforcement. Runs once per process.
const ensureOAuthReady = () =>
  ensureMcpResourceLinks(
    db,
    getOAuthResourceIdentifiers(getServerEnv().BETTER_AUTH_URL),
  );

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureOAuthReady();
        return getAuth().handler(request);
      },
      POST: async ({ request }) => {
        await ensureOAuthReady();
        const url = new URL(request.url);

        if (url.pathname === "/api/auth/oauth2/consent") {
          const headers = new Headers(request.headers);
          const auth = getAuth();
          const session = await auth.api.getSession({ headers });

          if (!session) {
            return new Response(
              JSON.stringify({
                error: "unauthorized",
                error_description: "Authentication required",
              }),
              {
                status: 401,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          if (session.user.role !== "admin" || session.user.banned) {
            return new Response(
              JSON.stringify({
                error: "access_denied",
                error_description:
                  "Only active administrators may grant MCP consent",
              }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }

        return getAuth().handler(request);
      },
    },
  },
});
