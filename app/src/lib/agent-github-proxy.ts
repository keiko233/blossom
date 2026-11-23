import { and, eq, gt } from "drizzle-orm";

import type { Database } from "@/db";
import { agentEnrollmentGrant } from "@/db/agent-identity-schema";
import { BOOTSTRAP_GRANT_PATTERN } from "@/lib/agent-bootstrap";
import { hashEnrollmentGrantSecret } from "@/lib/agent-enrollment";

/**
 * Control-plane fallback proxy for GitHub release lookups and asset downloads
 * used by the agent bootstrap script (`GET /api/agent/github/<owner>/<repo>/releases/...`).
 *
 * Abuse protections:
 * - Requires a valid, unredeemed, unexpired enrollment grant (`Authorization: Bearer egr_...`).
 * - Restricts repositories to `keiko233/blossom` and `SagerNet/sing-box`.
 * - Restricts paths to release tag lookups and Linux agent/sing-box binary assets.
 * - Enforces a per-grant request budget and upstream redirect/size/timeout guards.
 */

const ALLOWED_REPOS = new Map<string, string>([
  ["keiko233/blossom", "keiko233/blossom"],
  ["sagernet/sing-box", "SagerNet/sing-box"],
]);

const ALLOWED_UPSTREAM_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "codeload.github.com",
]);

const SAFE_TAG_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const AGENT_ASSET_PATTERN = /^server-agent-linux-(amd64|arm64)$/;
const SING_BOX_ASSET_PATTERN =
  /^sing-box-[A-Za-z0-9._+-]+-linux-(amd64|arm64)-musl\.tar\.gz$/;

const MAX_REDIRECTS = 5;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const UPSTREAM_TAG_TIMEOUT_MS = 15_000;
const UPSTREAM_ASSET_TIMEOUT_MS = 120_000;

const GRANT_RATE_WINDOW_MS = 10 * 60_000;
const GRANT_RATE_MAX_REQUESTS = 20;
const MAX_RATE_BUCKETS = 1024;

interface RateBucket {
  resetAt: number;
  count: number;
}

const grantRateBuckets = new Map<string, RateBucket>();

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

type ProxyTargetKind = "tag-redirect" | "tag-page" | "asset";

export interface ParsedGithubProxyTarget {
  repo: string;
  upstreamUrl: string;
  kind: ProxyTargetKind;
  tag?: string;
}

export interface GithubProxyDependencies {
  db: Database;
  /** Public control-plane origin, without a trailing slash. */
  publicOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Test seam: disable module-level rate-limit state. */
  disableRateLimit?: boolean;
}

function isSafeTagSegment(segment: string): boolean {
  return (
    segment !== "." &&
    segment !== ".." &&
    segment.length > 0 &&
    segment.length <= 128 &&
    SAFE_TAG_SEGMENT.test(segment)
  );
}

function isAllowedAsset(repo: string, asset: string): boolean {
  if (repo === "keiko233/blossom") {
    return AGENT_ASSET_PATTERN.test(asset);
  }
  if (repo === "SagerNet/sing-box") {
    return SING_BOX_ASSET_PATTERN.test(asset);
  }
  return false;
}

function isAllowedUpstreamHost(hostname: string): boolean {
  return ALLOWED_UPSTREAM_HOSTS.has(hostname.toLowerCase());
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

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
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

function consumeGrantRateLimit(tokenHash: string, nowMs: number): boolean {
  if (grantRateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [key, entry] of grantRateBuckets) {
      if (entry.resetAt <= nowMs) {
        grantRateBuckets.delete(key);
      }
    }
    if (grantRateBuckets.size > MAX_RATE_BUCKETS) {
      grantRateBuckets.clear();
    }
  }

  const existing = grantRateBuckets.get(tokenHash);
  if (!existing || existing.resetAt <= nowMs) {
    grantRateBuckets.set(tokenHash, {
      resetAt: nowMs + GRANT_RATE_WINDOW_MS,
      count: 1,
    });
    return true;
  }

  if (existing.count >= GRANT_RATE_MAX_REQUESTS) {
    return false;
  }
  existing.count += 1;
  return true;
}

/**
 * Validates and normalizes the splat path under `/api/agent/github/`.
 * Returns `null` for any disallowed repository, non-release path, or
 * unexpected asset name.
 */
export function parseGithubProxyTarget(
  rawSplat: string,
): ParsedGithubProxyTarget | null {
  const trimmed = rawSplat.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split("/");
  if (segments.length < 4) {
    return null;
  }

  const canonicalRepo = ALLOWED_REPOS.get(
    `${segments[0]}/${segments[1]}`.toLowerCase(),
  );
  if (!canonicalRepo || segments[2] !== "releases") {
    return null;
  }

  const rest = segments.slice(3);
  if (rest.length === 1 && rest[0] === "latest") {
    return {
      repo: canonicalRepo,
      upstreamUrl: `https://github.com/${canonicalRepo}/releases/latest`,
      kind: "tag-redirect",
      tag: "latest",
    };
  }

  if (rest.length === 2 && rest[0] === "tag" && isSafeTagSegment(rest[1])) {
    return {
      repo: canonicalRepo,
      upstreamUrl: `https://github.com/${canonicalRepo}/releases/tag/${rest[1]}`,
      kind: "tag-page",
      tag: rest[1],
    };
  }

  if (
    rest.length === 3 &&
    rest[0] === "latest" &&
    rest[1] === "download" &&
    isAllowedAsset(canonicalRepo, rest[2])
  ) {
    return {
      repo: canonicalRepo,
      upstreamUrl: `https://github.com/${canonicalRepo}/releases/latest/download/${rest[2]}`,
      kind: "asset",
      tag: "latest",
    };
  }

  if (
    rest.length === 3 &&
    rest[0] === "download" &&
    isSafeTagSegment(rest[1]) &&
    isAllowedAsset(canonicalRepo, rest[2])
  ) {
    return {
      repo: canonicalRepo,
      upstreamUrl: `https://github.com/${canonicalRepo}/releases/download/${rest[1]}/${rest[2]}`,
      kind: "asset",
      tag: rest[1],
    };
  }

  return null;
}

function buildUpstreamRequestHeaders(request: Request): Headers {
  const headers = new Headers({
    "user-agent": "blossom-control-plane",
    accept: "*/*",
  });
  const range = request.headers.get("range");
  if (range) {
    headers.set("range", range);
  }
  return headers;
}

function copySafeResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function rewriteTagLocation(
  location: string,
  repo: string,
  publicOrigin: string,
): string | null {
  let resolved: URL;
  try {
    resolved = new URL(location, `https://github.com/${repo}/releases/latest`);
  } catch {
    return null;
  }
  if (
    resolved.protocol !== "https:" ||
    resolved.hostname.toLowerCase() !== "github.com"
  ) {
    return null;
  }
  const prefix = `/${repo.toLowerCase()}/releases/tag/`;
  if (!resolved.pathname.toLowerCase().startsWith(prefix)) {
    return null;
  }
  const tag = resolved.pathname.slice(prefix.length);
  if (!isSafeTagSegment(tag)) {
    return null;
  }
  return `${publicOrigin.replace(/\/$/, "")}/api/agent/github/${repo}/releases/tag/${tag}`;
}

function exceedsMaxAssetSize(upstream: Response): boolean {
  const rawLength = upstream.headers.get("content-length");
  if (!rawLength) {
    return false;
  }
  const length = Number(rawLength);
  return Number.isFinite(length) && length > MAX_ASSET_BYTES;
}

export async function handleAgentGithubProxy(
  request: Request,
  rawSplat: string,
  deps: GithubProxyDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(405, "Method not allowed", { allow: "GET, HEAD" });
  }

  const target = parseGithubProxyTarget(rawSplat);
  if (!target) {
    return textResponse(404, "Not found");
  }

  const token = extractBearerGrant(request);
  if (!token) {
    return textResponse(401, "Unauthorized", {
      "www-authenticate": 'Bearer realm="blossom-agent-installer"',
    });
  }

  const now = deps.now?.() ?? new Date();
  const tokenHash = hashEnrollmentGrantSecret(token);
  const [grant] = await deps.db
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
    return textResponse(401, "Unauthorized", {
      "www-authenticate": 'Bearer realm="blossom-agent-installer"',
    });
  }

  // If the grant pinned a specific Blossom release version, refuse mismatched
  // server-agent release requests.
  if (
    target.repo === "keiko233/blossom" &&
    grant.release &&
    grant.release !== "latest" &&
    target.tag !== `v${grant.release.replace(/^v/, "")}`
  ) {
    return textResponse(403, "Release does not match enrollment grant");
  }

  if (
    !deps.disableRateLimit &&
    !consumeGrantRateLimit(tokenHash, now.getTime())
  ) {
    return textResponse(429, "Too many requests", { "retry-after": "60" });
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const requestHeaders = buildUpstreamRequestHeaders(request);

  if (target.kind === "tag-redirect") {
    let upstream: Response;
    try {
      upstream = await fetchImpl(target.upstreamUrl, {
        method: request.method,
        headers: requestHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TAG_TIMEOUT_MS),
      });
    } catch {
      return textResponse(502, "Upstream GitHub request failed");
    }

    if (isRedirectStatus(upstream.status)) {
      const location = upstream.headers.get("location");
      const rewritten = location
        ? rewriteTagLocation(location, target.repo, deps.publicOrigin)
        : null;
      if (!rewritten) {
        return textResponse(502, "Unexpected upstream redirect target");
      }
      return new Response(null, {
        status: upstream.status,
        headers: {
          location: rewritten,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: copySafeResponseHeaders(upstream),
    });
  }

  if (target.kind === "tag-page") {
    let upstream: Response;
    try {
      upstream = await fetchImpl(target.upstreamUrl, {
        method: request.method,
        headers: requestHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TAG_TIMEOUT_MS),
      });
    } catch {
      return textResponse(502, "Upstream GitHub request failed");
    }
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: copySafeResponseHeaders(upstream),
    });
  }

  // Asset download: follow redirects across allowlisted GitHub/CDN hosts and
  // stream the response body directly back to the caller.
  let currentUrl = target.upstreamUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let upstream: Response;
    try {
      upstream = await fetchImpl(currentUrl, {
        method: request.method,
        headers: requestHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_ASSET_TIMEOUT_MS),
      });
    } catch {
      return textResponse(502, "Upstream GitHub request failed");
    }

    if (!isRedirectStatus(upstream.status)) {
      if (exceedsMaxAssetSize(upstream)) {
        return textResponse(502, "Upstream asset exceeds size limit");
      }
      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        headers: copySafeResponseHeaders(upstream),
      });
    }

    const location = upstream.headers.get("location");
    if (!location) {
      return textResponse(502, "Upstream redirect missing location");
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return textResponse(502, "Invalid upstream redirect location");
    }

    if (
      nextUrl.protocol !== "https:" ||
      !isAllowedUpstreamHost(nextUrl.hostname)
    ) {
      return textResponse(502, "Disallowed upstream redirect target");
    }

    currentUrl = nextUrl.toString();
  }

  return textResponse(502, "Too many upstream redirects");
}
