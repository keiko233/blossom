import type { AgentReleaseManifest } from "@/lib/agent-installer-release";

/**
 * GitHub release feed for the "add a server" version selector.
 *
 * This is a convenience list, not an approval gate: the bootstrap endpoint
 * installs the selected GitHub release, and the curated
 * `APPROVED_AGENT_RELEASES` catalog (when non-empty) is merged in. A network
 * or rate-limit failure falls back to `latest` instead of blocking creation.
 */

const RELEASES_URL =
  "https://api.github.com/repos/keiko233/blossom/releases?per_page=10";
const CACHE_TTL_MS = 5 * 60_000;
const SEMVER_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export interface AgentReleaseVersionOption {
  /** What the grant stores and the installer receives: `latest` or `1.5.0`. */
  value: string;
  /** `null` for the `latest` pseudo-release. */
  tag: string | null;
  prerelease: boolean;
}

interface CacheEntry {
  at: number;
  options: AgentReleaseVersionOption[];
}

let cache: CacheEntry | null = null;

interface GitHubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function approvedOptions(
  approved: readonly AgentReleaseManifest[],
): AgentReleaseVersionOption[] {
  return approved.map((release) => ({
    value: release.version,
    tag: release.tag,
    prerelease: false,
  }));
}

function parseOptions(
  payload: unknown,
  approved: readonly AgentReleaseManifest[],
): AgentReleaseVersionOption[] {
  const releases = Array.isArray(payload) ? (payload as GitHubRelease[]) : [];
  const options: AgentReleaseVersionOption[] = [];
  for (const release of releases) {
    if (release.draft === true) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    if (!SEMVER_TAG.test(tag)) continue;
    options.push({
      value: tag.slice(1),
      tag,
      prerelease: release.prerelease === true,
    });
  }
  // An approved release is listed even when GitHub does not return it in the
  // first page (or the request failed).
  const seen = new Set(options.map((option) => option.value));
  for (const option of approvedOptions(approved)) {
    if (!seen.has(option.value)) {
      options.push(option);
      seen.add(option.value);
    }
  }
  return options;
}

function withLatest(
  options: AgentReleaseVersionOption[],
): AgentReleaseVersionOption[] {
  return [
    { value: "latest", tag: null, prerelease: false },
    ...options.filter((option) => option.value !== "latest"),
  ];
}

export interface ListAgentReleaseVersionsOptions {
  approved: readonly AgentReleaseManifest[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam: skip the module cache. */
  useCache?: boolean;
}

export async function listAgentReleaseVersions({
  approved,
  fetchImpl = fetch,
  now = Date.now,
  useCache = true,
}: ListAgentReleaseVersionsOptions): Promise<AgentReleaseVersionOption[]> {
  const cached = cache;
  if (useCache && cached && now() - cached.at < CACHE_TTL_MS) {
    // The approved catalog can change between requests only at build time, so a
    // cached GitHub list is still merged with the current catalog.
    return withLatest(mergeApproved(cached.options, approvedOptions(approved)));
  }

  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "blossom-control-plane",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub release feed returned ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const options = withLatest(parseOptions(payload, approved));
    if (useCache) cache = { at: now(), options };
    return options;
  } catch {
    // Rate limits, DNS failures and malformed responses degrade to latest.
    return withLatest(approvedOptions(approved));
  }
}

function mergeApproved(
  cached: AgentReleaseVersionOption[],
  approved: AgentReleaseVersionOption[],
): AgentReleaseVersionOption[] {
  const seen = new Set(cached.map((option) => option.value));
  const merged = [...cached];
  for (const option of approved) {
    if (!seen.has(option.value)) {
      merged.push(option);
      seen.add(option.value);
    }
  }
  return merged;
}

/** Test seam: clears the module-level release cache. */
export function resetAgentReleaseVersionCache(): void {
  cache = null;
}
