import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "@/lib/auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => getAuth().handler(request),
      POST: async ({ request }) => {
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
