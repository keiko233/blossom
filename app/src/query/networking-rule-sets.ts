import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

import { db } from "@/db";
import { managedRuleSetAsset } from "@/db/managed-network-schema";
import { fromInput } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  deriveRuleSetId,
  deriveRuleSetVersion,
  deriveSource,
  filterCatalogTree,
  isOfficialRuleSetRepo,
  OFFICIAL_RULE_SET_MAX_BYTES,
  officialBranchUrl,
  officialFileName,
  officialRuleSetUrls,
  officialTreeUrl,
  readBodyCapped,
  type OfficialRuleSetRepo,
} from "@/lib/github-rule-set-catalog";
import {
  customRuleSetInputSchema,
  importOfficialRuleSetSchema,
} from "@/lib/networking-rule-set-schema";
import {
  compileRuleSet,
  decodePayload,
  inspectSrs,
  unpackSrs,
  type RuleSetSource,
} from "@/lib/srs";
import { isSrsError, type SrsErrorCode } from "@/lib/srs/errors";
import { importRuleSetAssetDraft } from "@/query/networking-write";

export type OfficialCatalogReason =
  | "upstream_unavailable"
  | "upstream_rate_limited";

export interface OfficialCatalogEntryView {
  name: string;
  file: string;
  sizeBytes: number;
}

export interface OfficialCatalogRepoView {
  repo: OfficialRuleSetRepo;
  commit: string;
  committedAt: string | null;
  entries: OfficialCatalogEntryView[];
}

export interface OfficialCatalogSuccess {
  ok: true;
  fetchedAt: string;
  stale: boolean;
  repos: OfficialCatalogRepoView[];
}

export interface OfficialCatalogFailure {
  ok: false;
  reason: OfficialCatalogReason;
}

export type OfficialCatalogResult =
  | OfficialCatalogSuccess
  | OfficialCatalogFailure;

export type OfficialImportReason =
  | OfficialCatalogReason
  | "asset_too_large"
  | "duplicate_rule_set"
  | "upstream_invalid_asset"
  | "upstream_not_found";

export interface RuleSetStatsView {
  rules: number;
  domains: number;
  suffixes: number;
  keywords: number;
  regexes: number;
  cidrs: number;
  ports: number;
  ranges: number;
}

export interface OfficialImportSuccess {
  ok: true;
  ruleSetId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  commit: string;
  stats: RuleSetStatsView | null;
}

export interface OfficialImportFailure {
  ok: false;
  reason: OfficialImportReason;
  message: string;
}

export type OfficialImportResult =
  | OfficialImportSuccess
  | OfficialImportFailure;

export interface CustomRuleSetSuccess {
  ok: true;
  ruleSetId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  stats: RuleSetStatsView;
}

export interface CustomRuleSetIssue {
  code: SrsErrorCode;
  path: string | null;
}

export interface CustomRuleSetFailure {
  ok: false;
  reason: "invalid_rules" | "asset_too_large" | "duplicate_rule_set";
  message: string;
  issues?: CustomRuleSetIssue[];
}

export type CustomRuleSetResult = CustomRuleSetSuccess | CustomRuleSetFailure;

export interface RuleSetAssetSourceSuccess {
  ok: true;
  ruleSetId: string;
  version: string;
  source: RuleSetSource;
}

export interface RuleSetAssetSourceFailure {
  ok: false;
  reason: "not_found" | "unsupported";
}

export type RuleSetAssetSourceResult =
  | RuleSetAssetSourceSuccess
  | RuleSetAssetSourceFailure;

const UPSTREAM_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const GITHUB_API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "blossom-control-plane",
} as const;
const RAW_HEADERS = {
  accept: "application/octet-stream",
  "user-agent": "blossom-control-plane",
} as const;

let catalogCache:
  | { cachedAt: number; value: OfficialCatalogSuccess }
  | undefined;

class UpstreamError extends Error {
  constructor(
    readonly reason: OfficialCatalogReason,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 403 ||
    response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0"
  );
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new UpstreamError(
      isRateLimited(response)
        ? "upstream_rate_limited"
        : "upstream_unavailable",
      "GitHub request failed",
    );
  }
  return response.json();
}

function branchPin(value: unknown): {
  sha: string;
  treeSha: string;
  committedAt: string | null;
} {
  if (typeof value !== "object" || value === null) {
    throw new UpstreamError(
      "upstream_unavailable",
      "Malformed branch response",
    );
  }
  const record = value as Record<string, unknown>;
  const commit = record.commit;
  if (typeof commit !== "object" || commit === null) {
    throw new UpstreamError("upstream_unavailable", "Missing branch commit");
  }
  const commitRecord = commit as Record<string, unknown>;
  const sha = commitRecord.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new UpstreamError("upstream_unavailable", "Invalid branch commit");
  }
  const detail = commitRecord.commit;
  const committer =
    typeof detail === "object" && detail !== null
      ? (detail as Record<string, unknown>).committer
      : undefined;
  const date =
    typeof committer === "object" && committer !== null
      ? (committer as Record<string, unknown>).date
      : undefined;
  const tree =
    typeof detail === "object" && detail !== null
      ? (detail as Record<string, unknown>).tree
      : undefined;
  const treeSha =
    typeof tree === "object" && tree !== null
      ? (tree as Record<string, unknown>).sha
      : undefined;
  if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new UpstreamError("upstream_unavailable", "Invalid branch tree");
  }
  return {
    sha,
    treeSha,
    committedAt: typeof date === "string" ? date : null,
  };
}

function treeEntries(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) {
    throw new UpstreamError("upstream_unavailable", "Malformed tree response");
  }
  const tree = (value as Record<string, unknown>).tree;
  if (!Array.isArray(tree)) {
    throw new UpstreamError("upstream_unavailable", "Missing tree entries");
  }
  return tree;
}

async function loadOfficialRepo(
  repo: OfficialRuleSetRepo,
): Promise<OfficialCatalogRepoView> {
  const pin = branchPin(
    await fetchJson(officialBranchUrl(repo), GITHUB_API_HEADERS),
  );
  const entries = filterCatalogTree(
    treeEntries(
      await fetchJson(officialTreeUrl(repo, pin.treeSha), GITHUB_API_HEADERS),
    ) as never,
  );
  return {
    repo,
    commit: pin.sha,
    committedAt: pin.committedAt,
    entries,
  };
}

export const listOfficialRuleSets = createServerFn({ method: "GET" }).handler(
  async (): Promise<OfficialCatalogResult> => {
    await ensureAdmin();
    const cached =
      catalogCache && Date.now() - catalogCache.cachedAt <= CATALOG_TTL_MS
        ? catalogCache.value
        : undefined;
    if (cached) return { ...cached, stale: false };

    try {
      const [geosite, geoip] = await Promise.all([
        loadOfficialRepo("geosite"),
        loadOfficialRepo("geoip"),
      ]);
      const value: OfficialCatalogSuccess = {
        ok: true,
        fetchedAt: new Date().toISOString(),
        stale: false,
        repos: [geosite, geoip],
      };
      catalogCache = { cachedAt: Date.now(), value };
      return value;
    } catch (error) {
      if (catalogCache) {
        return { ...catalogCache.value, stale: true };
      }
      return {
        ok: false,
        reason:
          error instanceof UpstreamError
            ? error.reason
            : "upstream_unavailable",
      };
    }
  },
);

interface FetchedAsset {
  bytes: Uint8Array;
  commit: string;
  commitDate: string | null;
}

async function resolvePin(repo: OfficialRuleSetRepo): Promise<{
  sha: string | null;
  committedAt: string | null;
}> {
  try {
    const pin = branchPin(
      await fetchJson(officialBranchUrl(repo), GITHUB_API_HEADERS),
    );
    return { sha: pin.sha, committedAt: pin.committedAt };
  } catch {
    // A rate-limited or unavailable API must not disable the import. Fetch the
    // literal branch URL and derive the pin from the validated content instead.
    return { sha: null, committedAt: null };
  }
}

async function fetchOfficialAsset(
  repo: OfficialRuleSetRepo,
  file: string,
): Promise<
  | { ok: true; asset: FetchedAsset }
  | { ok: false; reason: OfficialImportReason; message: string }
> {
  const pin = await resolvePin(repo);
  const url = officialRuleSetUrls(repo, file, pin.sha ?? undefined);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: RAW_HEADERS,
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      reason: "upstream_unavailable",
      message: "The official rule-set host could not be reached",
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      reason: "upstream_not_found",
      message: "That official rule-set file does not exist",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "upstream_unavailable",
      message: "The official rule-set host returned an error",
    };
  }
  const read = await readBodyCapped(response, OFFICIAL_RULE_SET_MAX_BYTES);
  if (!read.ok) {
    return {
      ok: false,
      reason: read.reason,
      message:
        read.reason === "asset_too_large"
          ? "The official rule-set file exceeds 512 KiB"
          : "The official rule-set response was empty or unreadable",
    };
  }
  try {
    await unpackSrs(read.bytes);
  } catch {
    return {
      ok: false,
      reason: "upstream_invalid_asset",
      message: "The official file is not a valid SRS asset",
    };
  }

  const contentSha = createHash("sha256").update(read.bytes).digest("hex");
  const responseDate = response.headers.get("date");
  const parsedResponseDate = responseDate ? new Date(responseDate) : null;
  return {
    ok: true,
    asset: {
      bytes: read.bytes,
      commit: pin.sha ?? contentSha,
      commitDate:
        pin.committedAt ??
        (parsedResponseDate && !Number.isNaN(parsedResponseDate.getTime())
          ? parsedResponseDate.toISOString()
          : null),
    },
  };
}

export const importOfficialRuleSet = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.rule_set_import_official", {
      targetType: "managed_rule_set_asset",
      targetId: fromInput("name"),
    }),
  ])
  .validator(importOfficialRuleSetSchema)
  .handler(async ({ data }): Promise<OfficialImportResult> => {
    await ensureAdmin();
    if (!isOfficialRuleSetRepo(data.repo)) {
      return {
        ok: false,
        reason: "upstream_not_found",
        message: "Unknown official repository",
      };
    }
    let file: string;
    let ruleSetId: string;
    try {
      file = officialFileName(data.repo, data.name);
      ruleSetId = deriveRuleSetId(data.repo, data.name);
    } catch {
      return {
        ok: false,
        reason: "upstream_not_found",
        message: "Invalid official rule-set name",
      };
    }

    const fetched = await fetchOfficialAsset(data.repo, file);
    if (!fetched.ok) return fetched;
    const { asset } = fetched;

    const versionDate =
      asset.commitDate && !Number.isNaN(new Date(asset.commitDate).getTime())
        ? asset.commitDate
        : new Date().toISOString();
    const version = deriveRuleSetVersion(versionDate, asset.commit);
    let source: string;
    try {
      source = deriveSource(data.repo, asset.commit, file);
    } catch {
      return {
        ok: false,
        reason: "upstream_invalid_asset",
        message: "The upstream commit could not be pinned",
      };
    }

    let stats: RuleSetStatsView | null = null;
    try {
      const inspected = await inspectSrs(asset.bytes);
      stats = inspected.stats;
    } catch {
      stats = null;
    }

    const imported = await importRuleSetAssetDraft(
      {
        ruleSetId,
        version,
        source,
        contentBase64: Buffer.from(asset.bytes).toString("base64"),
      },
      db,
    );
    if (!imported.ok) {
      return {
        ok: false,
        reason:
          imported.reason === "duplicate_rule_set" ||
          imported.reason === "asset_too_large"
            ? imported.reason
            : "upstream_invalid_asset",
        message: imported.message,
      };
    }
    return {
      ok: true,
      ruleSetId: imported.ruleSetId,
      version: imported.version,
      sha256: imported.sha256,
      sizeBytes: imported.sizeBytes,
      commit: asset.commit,
      stats,
    };
  });

export const createCustomRuleSet = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.rule_set_create_custom", {
      targetType: "managed_rule_set_asset",
      targetId: fromInput("ruleSetId"),
    }),
  ])
  .validator(customRuleSetInputSchema)
  .handler(async ({ data }): Promise<CustomRuleSetResult> => {
    await ensureAdmin();
    let compiled: Awaited<ReturnType<typeof compileRuleSet>>;
    try {
      compiled = await compileRuleSet(data.rules);
    } catch (error) {
      if (isSrsError(error)) {
        return {
          ok: false,
          reason:
            error.code === "file_too_large"
              ? "asset_too_large"
              : "invalid_rules",
          message:
            error.code === "file_too_large"
              ? "The compiled asset exceeds 512 KiB"
              : error.code,
          issues: [
            {
              code: error.code,
              path: error.path ?? null,
            },
          ],
        };
      }
      return {
        ok: false,
        reason: "invalid_rules",
        message: "invalid_field",
        issues: [{ code: "invalid_field", path: null }],
      };
    }

    const imported = await importRuleSetAssetDraft(
      {
        ruleSetId: data.ruleSetId,
        version: data.version,
        source: `custom:${data.mode}`,
        contentBase64: Buffer.from(compiled.bytes).toString("base64"),
      },
      db,
    );
    if (!imported.ok) {
      return {
        ok: false,
        reason:
          imported.reason === "duplicate_rule_set"
            ? "duplicate_rule_set"
            : "asset_too_large",
        message: imported.message,
      };
    }
    return {
      ok: true,
      ruleSetId: imported.ruleSetId,
      version: imported.version,
      sha256: imported.sha256,
      sizeBytes: imported.sizeBytes,
      stats: compiled.stats,
    };
  });

/**
 * Decode one stored asset for "Duplicate as custom". Read-only and
 * admin-gated; the bytes never leave the server unvalidated by the codec.
 */
export const getRuleSetAssetSource = createServerFn({ method: "GET" })
  .validator(
    z.object({
      ruleSetId: z.string().min(1).max(64),
      version: z.string().min(1).max(64),
    }),
  )
  .handler(async ({ data }): Promise<RuleSetAssetSourceResult> => {
    await ensureAdmin();
    const [row] = await db
      .select({ contentBase64: managedRuleSetAsset.contentBase64 })
      .from(managedRuleSetAsset)
      .where(
        and(
          eq(managedRuleSetAsset.ruleSetId, data.ruleSetId),
          eq(managedRuleSetAsset.version, data.version),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, reason: "not_found" };
    try {
      const { payload } = await unpackSrs(
        Uint8Array.from(atob(row.contentBase64), (char) => char.charCodeAt(0)),
      );
      const decoded = decodePayload(payload);
      return {
        ok: true,
        ruleSetId: data.ruleSetId,
        version: data.version,
        source: { version: 1, rules: decoded.rules },
      };
    } catch {
      return { ok: false, reason: "unsupported" };
    }
  });
