import { and, eq, gt } from "drizzle-orm";

import type { Database } from "@/db";
import { agentEnrollmentGrant } from "@/db/agent-identity-schema";
import {
  BOOTSTRAP_GRANT_PATTERN,
  renderAgentBootstrapScript,
} from "@/lib/agent-bootstrap";
import { hashEnrollmentGrantSecret } from "@/lib/agent-enrollment";

/**
 * `GET /api/agent/install/<grant>.sh`. The grant in the URL is its only
 * authority. It is validated here and redeemed only when `server-agent enroll`
 * runs on the host, so a page reload does not spend it.
 *
 * Nothing in the response may be cached: the body contains the one-time grant.
 */

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
  });
}

export interface BootstrapRouteDependencies {
  db: Database;
  /** Public control-plane origin, without a trailing slash. */
  publicOrigin: string;
  now?: () => Date;
}

/** Strips the optional `.sh` extension from the route segment. */
export function bootstrapGrantToken(raw: string): string {
  return raw.endsWith(".sh") ? raw.slice(0, -3) : raw;
}

export async function handleAgentBootstrap(
  request: Request,
  rawToken: string,
  deps: BootstrapRouteDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(405, "Method not allowed", { allow: "GET, HEAD" });
  }

  const token = bootstrapGrantToken(rawToken);
  if (!BOOTSTRAP_GRANT_PATTERN.test(token)) {
    return textResponse(404, "Not found");
  }

  const now = deps.now?.() ?? new Date();
  const [grant] = await deps.db
    .select({
      id: agentEnrollmentGrant.id,
      serverId: agentEnrollmentGrant.serverId,
      status: agentEnrollmentGrant.status,
      release: agentEnrollmentGrant.release,
      expiresAt: agentEnrollmentGrant.expiresAt,
    })
    .from(agentEnrollmentGrant)
    .where(
      and(
        eq(agentEnrollmentGrant.tokenHash, hashEnrollmentGrantSecret(token)),
        gt(agentEnrollmentGrant.expiresAt, now),
      ),
    )
    .limit(1);

  // Unknown, expired, revoked, already claimed or already redeemed links all
  // look the same: the URL is a credential, not a status page.
  if (!grant || grant.status !== "issued" || grant.expiresAt <= now) {
    return textResponse(
      404,
      "This install link is no longer valid. Ask an administrator for a new one.",
    );
  }

  let script: string;
  try {
    script = renderAgentBootstrapScript({
      publicOrigin: deps.publicOrigin.replace(/\/$/, ""),
      enrollmentGrant: token,
      release: grant.release,
    });
  } catch (error) {
    console.error("[agent-bootstrap] cannot render the installer", error);
    return textResponse(500, "The installer cannot be rendered");
  }

  return textResponse(200, script, {
    "content-type": "text/x-shellscript; charset=utf-8",
  });
}
