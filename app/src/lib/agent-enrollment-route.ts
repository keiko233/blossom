import type { Database } from "@/db";
import { getClientIp } from "@/lib/client-ip";
import {
  type EnrollmentRedeemFailure,
  redeemEnrollmentGrant,
} from "@/query/agent-identity-store";

import { redeemEnrollmentBodySchema } from "./agent-enrollment";
import {
  AGENT_MACHINE_SCOPE,
  AGENT_TOKEN_LIFETIME_SECONDS,
  type OAuthResourceIdentifiers,
} from "./oauth-provider-config";

/**
 * `POST /api/agent/enrollment/redeem`. The agent has no credential yet: the
 * one-time grant in the body is the only authority, and it resolves to exactly
 * one server. A successful response is the only place the client secret is ever
 * returned. Responses are `no-store`, and nothing in them is logged.
 */

const MAX_BODY_BYTES = 4096;

const FAILURES: Record<
  EnrollmentRedeemFailure,
  { status: number; error: string; description: string }
> = {
  invalid_grant: {
    status: 400,
    error: "invalid_grant",
    description: "The enrollment grant is unknown, expired, or revoked.",
  },
  grant_unavailable: {
    status: 409,
    error: "grant_unavailable",
    description:
      "The grant was already redeemed or is being redeemed, or the server's identity state refuses this grant. Ask an administrator for a new grant.",
  },
  server_disabled: {
    status: 403,
    error: "server_disabled",
    description: "The server is disabled.",
  },
};

export interface EnrollmentRouteDeps {
  db: Database;
  resources: OAuthResourceIdentifiers;
  /** Public control-plane origin, without a trailing slash. */
  origin: string;
  now?: () => Date;
}

export async function handleEnrollmentRedeem(
  request: Request,
  deps: EnrollmentRouteDeps,
): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "Send application/json.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse(
      413,
      "payload_too_large",
      "The request body is too large.",
    );
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return errorResponse(
      413,
      "payload_too_large",
      "The request body is too large.",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return errorResponse(400, "invalid_request", "The body is not valid JSON.");
  }
  const body = redeemEnrollmentBodySchema.safeParse(json);
  if (!body.success) {
    return errorResponse(
      400,
      "invalid_request",
      "Send enrollmentGrant and optional hostInfo.",
    );
  }

  const result = await redeemEnrollmentGrant(deps.db, {
    secret: body.data.enrollmentGrant,
    resources: deps.resources,
    now: deps.now?.() ?? new Date(),
    hostInfo: body.data.hostInfo,
    clientIp: getClientIp(request),
  });

  if (!result.ok) {
    const failure = FAILURES[result.reason];
    return errorResponse(failure.status, failure.error, failure.description);
  }

  return jsonResponse(200, {
    serverId: result.serverId,
    identityId: result.identityId,
    generation: result.generation,
    identityStatus: "pending",
    clientId: result.clientId,
    clientSecret: result.clientSecret,
    clientAuthMethod: "client_secret_basic",
    grantType: "client_credentials",
    tokenEndpoint: `${deps.origin}/api/auth/oauth2/token`,
    issuer: `${deps.origin}/api/auth`,
    resource: deps.resources.agent,
    scope: AGENT_MACHINE_SCOPE,
    tokenLifetimeSeconds: AGENT_TOKEN_LIFETIME_SECONDS,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

function errorResponse(status: number, error: string, description: string) {
  return jsonResponse(status, { error, error_description: description });
}
