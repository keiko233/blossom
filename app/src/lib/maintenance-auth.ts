import { timingSafeEqual } from "node:crypto";

export const NO_STORE_HEADERS: HeadersInit = {
  "cache-control": "no-store",
};

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Authorize a scheduler or deploy-hook request against `MAINTENANCE_TOKEN`.
 * Returns `null` when authorized, or an error `Response` (`503` if the token
 * is unset, `401` if the bearer token is missing or invalid).
 */
export function authorizeMaintenanceRequest(
  request: Request,
  expectedToken: string | undefined,
): Response | null {
  if (!expectedToken) {
    return Response.json(
      { error: "maintenance_disabled" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const token = parseBearerToken(request);
  if (!token || !sameSecret(token, expectedToken)) {
    return new Response(null, { status: 401, headers: NO_STORE_HEADERS });
  }
  return null;
}
