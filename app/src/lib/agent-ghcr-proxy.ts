import { and, eq, gt } from "drizzle-orm";

import type { Database } from "@/db";
import { agentEnrollmentGrant } from "@/db/agent-identity-schema";
import { BOOTSTRAP_GRANT_PATTERN } from "@/lib/agent-bootstrap";
import { hashEnrollmentGrantSecret } from "@/lib/agent-enrollment";

/**
 * Control-plane OCI/Docker pull-through proxy for `ghcr.io/keiko233/blossom/server-agent`.
 *
 * Used by `install_docker()` in the bootstrap script when direct pulls from
 * `ghcr.io` fail or time out.
 *
 * Abuse protections:
 * - Requires a valid, unredeemed, unexpired `agent_enrollment_grant` (`egr_...`).
 * - Strictly allowlists `keiko233/blossom/server-agent` manifests and blobs.
 * - Enforces pinned grant release version (when non-`latest`) on tag manifests.
 * - Enforces per-grant rate limiting, allowlisted CDN redirect hosts, and size/timeout caps.
 */

const ALLOWED_REPOSITORY = "keiko233/blossom/server-agent";
const ALLOWED_SCOPE = `repository:${ALLOWED_REPOSITORY}:pull`;
const GHCR_ORIGIN = "https://ghcr.io";

const ALLOWED_BLOB_HOSTS = new Set([
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TAG_PATTERN = /^[A-Za-z0-9._+-]{1,128}$/;

const MAX_REDIRECTS = 5;
const MAX_BLOB_BYTES = 200 * 1024 * 1024;
const UPSTREAM_META_TIMEOUT_MS = 15_000;
const UPSTREAM_BLOB_TIMEOUT_MS = 120_000;

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_REQUESTS = 40;
const MAX_RATE_BUCKETS = 1024;

interface RateBucket {
  resetAt: number;
  count: number;
}

const rateBuckets = new Map<string, RateBucket>();

const FORWARDED_REGISTRY_HEADERS = [
  "content-length",
  "content-type",
  "docker-content-digest",
  "etag",
  "last-modified",
  "accept-ranges",
  "content-range",
];

export type ParsedGhcrTarget =
  | { kind: "ping" }
  | { kind: "manifest"; reference: string }
  | { kind: "blob"; digest: string };

export interface GhcrProxyDependencies {
  db: Database;
  /** Public control-plane origin, without a trailing slash. */
  publicOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Test seam: disable module-level rate-limit state. */
  disableRateLimit?: boolean;
}

function isAllowedBlobHost(hostname: string): boolean {
  return ALLOWED_BLOB_HOSTS.has(hostname.toLowerCase());
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "docker-distribution-api-version": "registry/2.0",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function ociErrorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { errors: [{ code, message }] }, headers);
}

function wwwAuthenticateHeader(publicOrigin: string): string {
  const realm = `${publicOrigin.replace(/\/$/, "")}/api/agent/ghcr/token`;
  return `Bearer realm="${realm}",service="blossom-ghcr",scope="${ALLOWED_SCOPE}"`;
}

function extractBearerGrant(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (!match) {
    return null;
  }
  const token = match[1];
  return BOOTSTRAP_GRANT_PATTERN.test(token) ? token : null;
}

function extractBasicGrant(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) {
    return null;
  }
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth.trim());
  if (!match) {
    return null;
  }
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) {
    return null;
  }
  const password = decoded.slice(colonIdx + 1);
  return BOOTSTRAP_GRANT_PATTERN.test(password) ? password : null;
}

function consumeRateLimit(tokenHash: string, nowMs: number): boolean {
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [key, entry] of rateBuckets) {
      if (entry.resetAt <= nowMs) {
        rateBuckets.delete(key);
      }
    }
    if (rateBuckets.size > MAX_RATE_BUCKETS) {
      rateBuckets.clear();
    }
  }

  const existing = rateBuckets.get(tokenHash);
  if (!existing || existing.resetAt <= nowMs) {
    rateBuckets.set(tokenHash, {
      resetAt: nowMs + RATE_WINDOW_MS,
      count: 1,
    });
    return true;
  }

  if (existing.count >= RATE_MAX_REQUESTS) {
    return false;
  }
  existing.count += 1;
  return true;
}

async function lookupActiveGrant(
  db: Database,
  token: string,
  now: Date,
): Promise<{ id: string; release: string | null; tokenHash: string } | null> {
  const tokenHash = hashEnrollmentGrantSecret(token);
  const [grant] = await db
    .select({
      id: agentEnrollmentGrant.id,
      status: agentEnrollmentGrant.status,
      release: agentEnrollmentGrant.release,
      expiresAt: agentEnrollmentGrant.expiresAt,
    })
    .from(agentEnrollmentGrant)
    .where(
      and(
        eq(agentEnrollmentGrant.tokenHash, tokenHash),
        gt(agentEnrollmentGrant.expiresAt, now),
      ),
    )
    .limit(1);

  if (!grant || grant.status !== "issued" || grant.expiresAt <= now) {
    return null;
  }
  return { id: grant.id, release: grant.release, tokenHash };
}

export function parseGhcrTarget(rawSplat: string): ParsedGhcrTarget | null {
  const trimmed = rawSplat.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return { kind: "ping" };
  }

  const prefix = `${ALLOWED_REPOSITORY}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const rest = trimmed.slice(prefix.length).split("/");
  if (rest.length !== 2) {
    return null;
  }

  if (rest[0] === "manifests") {
    const ref = rest[1];
    if (
      ref !== "." &&
      ref !== ".." &&
      (DIGEST_PATTERN.test(ref) || TAG_PATTERN.test(ref))
    ) {
      return { kind: "manifest", reference: ref };
    }
    return null;
  }

  if (rest[0] === "blobs" && DIGEST_PATTERN.test(rest[1])) {
    return { kind: "blob", digest: rest[1] };
  }

  return null;
}

function copySafeRegistryHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REGISTRY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  headers.set("cache-control", "private, no-store");
  headers.set("docker-distribution-api-version", "registry/2.0");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

async function fetchUpstreamGhcrToken(
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const tokenUrl = `${GHCR_ORIGIN}/token?service=ghcr.io&scope=${encodeURIComponent(ALLOWED_SCOPE)}`;
  const response = await fetchImpl(tokenUrl, {
    method: "GET",
    headers: {
      "user-agent": "blossom-control-plane",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(UPSTREAM_META_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as {
    token?: unknown;
    access_token?: unknown;
  };
  if (typeof payload.token === "string" && payload.token.length > 0) {
    return payload.token;
  }
  if (
    typeof payload.access_token === "string" &&
    payload.access_token.length > 0
  ) {
    return payload.access_token;
  }
  return null;
}

export async function handleAgentGhcrToken(
  request: Request,
  deps: GhcrProxyDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return ociErrorResponse(405, "UNSUPPORTED", "Method not allowed", {
      allow: "GET, POST",
    });
  }

  const url = new URL(request.url);
  const scopes = url.searchParams.getAll("scope");
  if (scopes.some((scope) => scope !== "" && scope !== ALLOWED_SCOPE)) {
    return ociErrorResponse(403, "DENIED", "Requested scope is not allowed");
  }

  let token = extractBasicGrant(request);
  if (!token && request.method === "POST") {
    try {
      const form = await request.formData();
      const candidate =
        form.get("refresh_token") ?? form.get("password") ?? form.get("code");
      if (
        typeof candidate === "string" &&
        BOOTSTRAP_GRANT_PATTERN.test(candidate)
      ) {
        token = candidate;
      }
    } catch {
      return ociErrorResponse(400, "UNSUPPORTED", "Invalid token request body");
    }
  }

  if (!token) {
    return ociErrorResponse(401, "UNAUTHORIZED", "Invalid enrollment grant", {
      "www-authenticate": wwwAuthenticateHeader(deps.publicOrigin),
    });
  }

  const now = deps.now?.() ?? new Date();
  const grant = await lookupActiveGrant(deps.db, token, now);
  if (!grant) {
    return ociErrorResponse(401, "UNAUTHORIZED", "Invalid enrollment grant", {
      "www-authenticate": wwwAuthenticateHeader(deps.publicOrigin),
    });
  }

  if (
    !deps.disableRateLimit &&
    !consumeRateLimit(grant.tokenHash, now.getTime())
  ) {
    return ociErrorResponse(429, "TOOMANYREQUESTS", "Too many requests", {
      "retry-after": "60",
    });
  }

  return jsonResponse(200, {
    token,
    access_token: grant.id ? token : token,
    expires_in: 300,
    issued_at: now.toISOString(),
  });
}

export async function handleAgentGhcrV2(
  request: Request,
  rawSplat: string,
  deps: GhcrProxyDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return ociErrorResponse(405, "UNSUPPORTED", "Method not allowed", {
      allow: "GET, HEAD",
    });
  }

  const target = parseGhcrTarget(rawSplat);
  if (!target) {
    return ociErrorResponse(
      404,
      "NAME_UNKNOWN",
      "Repository or resource is not allowed",
    );
  }

  const token = extractBearerGrant(request);
  if (!token) {
    return ociErrorResponse(401, "UNAUTHORIZED", "Authentication required", {
      "www-authenticate": wwwAuthenticateHeader(deps.publicOrigin),
    });
  }

  const now = deps.now?.() ?? new Date();
  const grant = await lookupActiveGrant(deps.db, token, now);
  if (!grant) {
    return ociErrorResponse(401, "UNAUTHORIZED", "Invalid enrollment grant", {
      "www-authenticate": wwwAuthenticateHeader(deps.publicOrigin),
    });
  }

  if (
    target.kind === "manifest" &&
    !DIGEST_PATTERN.test(target.reference) &&
    grant.release &&
    grant.release !== "latest" &&
    target.reference !== grant.release.replace(/^v/, "")
  ) {
    return ociErrorResponse(
      403,
      "DENIED",
      "Tag does not match enrollment grant release",
    );
  }

  if (
    !deps.disableRateLimit &&
    !consumeRateLimit(grant.tokenHash, now.getTime())
  ) {
    return ociErrorResponse(429, "TOOMANYREQUESTS", "Too many requests", {
      "retry-after": "60",
    });
  }

  if (target.kind === "ping") {
    return jsonResponse(200, {});
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let ghcrToken: string | null;
  try {
    ghcrToken = await fetchUpstreamGhcrToken(fetchImpl);
  } catch {
    return ociErrorResponse(
      502,
      "UNAVAILABLE",
      "Upstream GHCR token request failed",
    );
  }
  if (!ghcrToken) {
    return ociErrorResponse(
      502,
      "UNAVAILABLE",
      "Upstream GHCR token unavailable",
    );
  }

  if (target.kind === "manifest") {
    const upstreamHeaders = new Headers({
      "user-agent": "blossom-control-plane",
      authorization: `Bearer ${ghcrToken}`,
    });
    const accept = request.headers.get("accept");
    if (accept) {
      upstreamHeaders.set("accept", accept);
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(
        `${GHCR_ORIGIN}/v2/${ALLOWED_REPOSITORY}/manifests/${target.reference}`,
        {
          method: request.method,
          headers: upstreamHeaders,
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_META_TIMEOUT_MS),
        },
      );
    } catch {
      return ociErrorResponse(
        502,
        "UNAVAILABLE",
        "Upstream GHCR manifest request failed",
      );
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: copySafeRegistryHeaders(upstream),
    });
  }

  // Blob download: follow redirects across allowlisted GHCR/CDN hosts,
  // stripping the GHCR Bearer token before hitting external blob CDNs.
  let currentUrl = `${GHCR_ORIGIN}/v2/${ALLOWED_REPOSITORY}/blobs/${target.digest}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const urlObj = new URL(currentUrl);
    const headers = new Headers({
      "user-agent": "blossom-control-plane",
      accept: "*/*",
    });
    if (urlObj.hostname.toLowerCase() === "ghcr.io") {
      headers.set("authorization", `Bearer ${ghcrToken}`);
    }
    const range = request.headers.get("range");
    if (range) {
      headers.set("range", range);
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(currentUrl, {
        method: request.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_BLOB_TIMEOUT_MS),
      });
    } catch {
      return ociErrorResponse(
        502,
        "UNAVAILABLE",
        "Upstream GHCR blob request failed",
      );
    }

    if (!isRedirectStatus(upstream.status)) {
      const rawLength = upstream.headers.get("content-length");
      const length = rawLength ? Number(rawLength) : NaN;
      if (Number.isFinite(length) && length > MAX_BLOB_BYTES) {
        return ociErrorResponse(
          502,
          "UNAVAILABLE",
          "Upstream blob exceeds size limit",
        );
      }
      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        headers: copySafeRegistryHeaders(upstream),
      });
    }

    const location = upstream.headers.get("location");
    if (!location) {
      return ociErrorResponse(
        502,
        "UNAVAILABLE",
        "Upstream redirect missing location",
      );
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return ociErrorResponse(
        502,
        "UNAVAILABLE",
        "Invalid upstream redirect location",
      );
    }

    if (nextUrl.protocol !== "https:" || !isAllowedBlobHost(nextUrl.hostname)) {
      return ociErrorResponse(
        502,
        "UNAVAILABLE",
        "Disallowed upstream redirect target",
      );
    }

    currentUrl = nextUrl.toString();
  }

  return ociErrorResponse(502, "UNAVAILABLE", "Too many upstream redirects");
}
