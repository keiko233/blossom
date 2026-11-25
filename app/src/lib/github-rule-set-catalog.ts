/**
 * Pure allowlist and naming rules for importing official sing-box rule sets.
 *
 * Nothing in this module performs I/O. Every URL is built from these constants
 * and a commit SHA obtained by the server from the GitHub API, so no
 * user-controlled host, path segment or ref can reach a request.
 */

export const OFFICIAL_RULE_SET_REPOS = ["geosite", "geoip"] as const;
export type OfficialRuleSetRepo = (typeof OFFICIAL_RULE_SET_REPOS)[number];

export const OFFICIAL_RULE_SET_BRANCH = "rule-set";
export const OFFICIAL_RULE_SET_API_HOST = "api.github.com";
export const OFFICIAL_RULE_SET_RAW_HOST = "raw.githubusercontent.com";
export const OFFICIAL_RULE_SET_OWNER = "SagerNet";
export const OFFICIAL_RULE_SET_MAX_BYTES = 524_288;
export const OFFICIAL_RULE_SET_MAX_NAME_LENGTH = 80;

const REPO_SLUGS: Readonly<Record<OfficialRuleSetRepo, string>> = {
  geosite: "sing-geosite",
  geoip: "sing-geoip",
};

/** Names are already stripped of the `geosite-`/`geoip-` prefix and `.srs`. */
export const OFFICIAL_RULE_SET_NAME_PATTERN = /^[a-z0-9][a-z0-9@!._-]{0,80}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/**
 * A pin is a 40-hex commit fetched from the GitHub API, or the 64-hex content
 * hash used when that API is unavailable. Both are immutable and safe in a URL
 * path segment or provenance string.
 */
const PIN_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TREE_FILE_PATTERN = /^geo(site|ip)-[a-z0-9][a-z0-9@!._-]*\.srs$/;
const RULE_SET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isOfficialRuleSetRepo(
  value: unknown,
): value is OfficialRuleSetRepo {
  return (
    typeof value === "string" &&
    (OFFICIAL_RULE_SET_REPOS as readonly string[]).includes(value)
  );
}

/** Returns the validated name, or null. Never trims: whitespace is invalid. */
export function parseOfficialName(
  repo: OfficialRuleSetRepo,
  name: unknown,
): string | null {
  if (!isOfficialRuleSetRepo(repo)) return null;
  if (typeof name !== "string") return null;
  if (!OFFICIAL_RULE_SET_NAME_PATTERN.test(name)) return null;
  if (name.length > OFFICIAL_RULE_SET_MAX_NAME_LENGTH) return null;
  if (name.endsWith(".srs")) return null;
  return name;
}

export function repoSlug(repo: OfficialRuleSetRepo): string {
  return REPO_SLUGS[repo];
}

export function officialFileName(
  repo: OfficialRuleSetRepo,
  name: string,
): string {
  const parsed = parseOfficialName(repo, name);
  if (!parsed) throw new Error("Invalid official rule-set name");
  return `${repo}-${parsed}.srs`;
}

export function officialBranchUrl(repo: OfficialRuleSetRepo): string {
  return `https://${OFFICIAL_RULE_SET_API_HOST}/repos/${OFFICIAL_RULE_SET_OWNER}/${repoSlug(repo)}/branches/${OFFICIAL_RULE_SET_BRANCH}`;
}

export function officialTreeUrl(
  repo: OfficialRuleSetRepo,
  treeSha: string,
): string {
  if (!COMMIT_PATTERN.test(treeSha)) throw new Error("Invalid tree SHA");
  return `https://${OFFICIAL_RULE_SET_API_HOST}/repos/${OFFICIAL_RULE_SET_OWNER}/${repoSlug(repo)}/git/trees/${treeSha}`;
}

/**
 * The raw URL only ever names one of the two allowlisted repositories. When
 * `sha` is omitted the literal branch name is used; the import always passes a
 * commit SHA it obtained from the API (or the content-derived fallback).
 */
export function officialRuleSetUrls(
  repo: OfficialRuleSetRepo,
  file: string,
  sha?: string,
): string {
  if (!TREE_FILE_PATTERN.test(file)) throw new Error("Invalid official file");
  const prefix = `${repo}-`;
  if (!file.startsWith(prefix)) throw new Error("Invalid official file");
  const name = file.slice(prefix.length, -".srs".length);
  if (!parseOfficialName(repo, name)) {
    throw new Error("Invalid official rule-set file");
  }
  const ref = sha ?? OFFICIAL_RULE_SET_BRANCH;
  if (ref !== OFFICIAL_RULE_SET_BRANCH && !/^[0-9a-f]{40}$/.test(ref)) {
    throw new Error("Invalid commit SHA");
  }
  return `https://${OFFICIAL_RULE_SET_RAW_HOST}/${OFFICIAL_RULE_SET_OWNER}/${repoSlug(repo)}/${ref}/${file}`;
}

/** `acer@cn` -> `geosite-acer-at-cn`; `airchina@!cn` -> `geosite-airchina-at-not-cn`. */
export function deriveRuleSetId(
  repo: OfficialRuleSetRepo,
  name: string,
): string {
  const parsed = parseOfficialName(repo, name);
  if (!parsed) throw new Error("Invalid official rule-set name");
  const id = `${repo}-${parsed
    .replaceAll("@!", "-at-not-")
    .replaceAll("@", "-at-")
    .replaceAll("!", "-not-")}`;
  if (id.length > 64 || !RULE_SET_ID_PATTERN.test(id)) {
    throw new Error("Derived rule-set id is invalid");
  }
  return id;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTC `YYYY.MM.DD-<sha7>` from a commit timestamp and its full SHA. */
export function deriveRuleSetVersion(commitDate: string, sha: string): string {
  if (!PIN_PATTERN.test(sha)) throw new Error("Invalid commit pin");
  const date = new Date(commitDate);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid commit date");
  const version = `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}-${sha.slice(0, 7)}`;
  if (!VERSION_PATTERN.test(version) || version.length > 64) {
    throw new Error("Derived version is invalid");
  }
  return version;
}

export function deriveSource(
  repo: OfficialRuleSetRepo,
  sha: string,
  file: string,
): string {
  if (!PIN_PATTERN.test(sha)) throw new Error("Invalid commit pin");
  return `github:${OFFICIAL_RULE_SET_OWNER}/${repoSlug(repo)}@${sha}/${file}`;
}

export interface OfficialCatalogEntry {
  name: string;
  file: string;
  sizeBytes: number;
}

/** Keep root blobs named `geosite-*.srs`/`geoip-*.srs` within the 512 KiB cap. */
export function filterCatalogTree(
  entries: readonly unknown[],
): OfficialCatalogEntry[] {
  const result: OfficialCatalogEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "blob") continue;
    if (typeof record.path !== "string") continue;
    const file = record.path;
    if (!TREE_FILE_PATTERN.test(file)) continue;
    if (typeof record.size !== "number" || !Number.isInteger(record.size)) {
      continue;
    }
    if (record.size < 1 || record.size > OFFICIAL_RULE_SET_MAX_BYTES) continue;
    result.push({
      name: file.replace(/^geo(site|ip)-/, "").replace(/\.srs$/, ""),
      file,
      sizeBytes: record.size,
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export type RuleSetOrigin = "official" | "custom" | "upload";

/** `github:SagerNet/` is official, `custom:` is custom, anything else is upload. */
export function ruleSetOrigin(source: string): RuleSetOrigin {
  if (source.startsWith(`github:${OFFICIAL_RULE_SET_OWNER}/`))
    return "official";
  if (source.startsWith("custom:")) return "custom";
  return "upload";
}

/**
 * Next integer when every existing version is an integer, otherwise today's
 * UTC date. Empty input suggests `"1"`.
 */
export function suggestRuleSetVersion(existing: readonly string[]): string {
  if (existing.length > 0 && existing.every((value) => /^\d+$/.test(value))) {
    return String(Math.max(...existing.map(Number)) + 1);
  }
  if (existing.length === 0) return "1";
  const today = new Date();
  return `${today.getUTCFullYear()}.${pad(today.getUTCMonth() + 1)}.${pad(today.getUTCDate())}`;
}

/**
 * Stream a fetch response body with a hard byte cap. Exported so the cap is
 * unit-tested with real `Response` objects.
 */
export async function readBodyCapped(
  response: Response,
  limit: number,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "asset_too_large" | "upstream_invalid_asset" }
> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    return { ok: false, reason: "asset_too_large" };
  }
  if (!response.body) return { ok: false, reason: "upstream_invalid_asset" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "asset_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "upstream_invalid_asset" };
  }
  if (total === 0) return { ok: false, reason: "upstream_invalid_asset" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
}
