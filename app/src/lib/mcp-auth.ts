import { verifyJwsAccessToken } from "better-auth/oauth2";

import type { AuthInfo } from "@/orpc/mcp/auth-context";

type JwksFetcher = Exclude<
  Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
  string
>;

interface McpOAuthHandlerOptions {
  origin: string;
  audience: string;
  issuer: string;
  getJwks: JwksFetcher;
  handler: (request: Request) => Promise<Response>;
}

export function createMcpOAuthHandler({
  origin,
  audience,
  issuer,
  getJwks,
  handler,
}: McpOAuthHandlerOptions): (request: Request) => Promise<Response> {
  const jwksCacheKey = {};

  return async (request) => {
    const accessToken = getBearerToken(request.headers.get("Authorization"));
    if (!accessToken) {
      return unauthorizedMcpResponse(origin, audience, "missing access token");
    }

    try {
      const jwt = await verifyJwsAccessToken(accessToken, {
        jwksFetch: getJwks,
        jwksCacheKey,
        verifyOptions: { audience, issuer },
      });
      const scopes = Array.isArray(jwt.scope)
        ? jwt.scope
        : typeof jwt.scope === "string"
          ? jwt.scope.split(" ")
          : [];

      (request as Request & { auth?: AuthInfo }).auth = {
        token: accessToken,
        clientId: ((jwt.client_id ?? jwt.azp) as string) ?? "",
        scopes,
        expiresAt: jwt.exp,
        extra: { ...jwt, sub: jwt.sub, scopes },
      };

      return handler(request);
    } catch (error) {
      console.warn(
        "MCP access token verification failed",
        error instanceof Error ? error.message : "unknown error",
      );
      return unauthorizedMcpResponse(origin, audience, "invalid access token");
    }
  };
}

function getBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function unauthorizedMcpResponse(
  origin: string,
  audience: string,
  message: string,
): Response {
  const resourcePath = new URL(audience).pathname.replace(/\/$/, "");
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource${resourcePath}`;

  return new Response(message, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    },
  });
}
