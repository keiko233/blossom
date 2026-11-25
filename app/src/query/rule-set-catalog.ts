import { MANAGED_SNAPSHOT_BYTE_BUDGETS } from "@blossom/domain/managed-networking";
import { createServerFn } from "@tanstack/react-start";
import { createHash } from "node:crypto";
import { z } from "zod";

import { db, type Database } from "@/db";
import { fromInput } from "@/lib/admin-audit";
import { adminAudit } from "@/lib/admin-audit-middleware";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  findCuratedRuleSetEntry,
  isCuratedRuleSetUrl,
} from "@/lib/rule-set-catalog";
import { importRuleSetAssetDraft } from "@/query/networking-write";

/**
 * Curated rule-set import.
 *
 * The only URLs this module ever requests come from
 * `CURATED_RULE_SET_CATALOG`; no user value is treated as a URL or a path.
 * Bytes are size-checked before they reach the existing rule-set asset writer,
 * which decodes, re-bounds and SHA-256 hashes them before the insert.
 */

export const FETCH_CURATED_RULE_SET_REASONS = [
  "unknown_preset",
  "fetch_failed",
  "http_status",
  "unsafe_url",
  "empty_body",
  "asset_too_large",
  "import_failed",
] as const;

export type FetchCuratedRuleSetReason =
  (typeof FETCH_CURATED_RULE_SET_REASONS)[number];

export type FetchCuratedRuleSetResult =
  | {
      ok: true;
      ruleSetId: string;
      version: string;
      source: string;
      url: string;
      sha256: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      reason: FetchCuratedRuleSetReason;
      message: string;
      /** The rule-set writer's stable reason, when the import itself failed. */
      importReason?: string;
    };

export interface FetchCuratedRuleSetOptions {
  /** Injectable for offline tests. Never called with a user-supplied URL. */
  fetchImpl?: typeof fetch;
  database?: Database;
  /** Overrides the catalog's pinned default version. */
  version?: string;
}

type BoundedBodyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "asset_too_large" };

/**
 * Reads a response body without ever buffering more than the rule-set budget.
 * `Response.arrayBuffer` is only used when the runtime exposes no stream.
 */
async function readBoundedBody(
  response: Response,
  limitBytes: number,
): Promise<BoundedBodyResult> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > limitBytes) {
      return { ok: false, reason: "asset_too_large" };
    }
    return { ok: true, bytes };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "asset_too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    ok: true,
    bytes: Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ),
  };
}

/**
 * Downloads one catalog entry and imports it as a pinned binary asset.
 * Unknown ids, non-200 responses, empty bodies and over-budget downloads fail
 * before the writer sees anything.
 */
export async function fetchAndImportCuratedRuleSet(
  presetId: string,
  options: FetchCuratedRuleSetOptions = {},
): Promise<FetchCuratedRuleSetResult> {
  const entry = findCuratedRuleSetEntry(presetId);
  if (!entry) {
    return {
      ok: false,
      reason: "unknown_preset",
      message: `Unknown curated rule-set preset ${presetId}`,
    };
  }
  if (!isCuratedRuleSetUrl(entry.url)) {
    return {
      ok: false,
      reason: "unsafe_url",
      message: "The catalog entry is not an official SagerNet rule-set URL",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const version = options.version ?? entry.defaultVersion;
  let response: Response;
  try {
    response = await fetchImpl(entry.url, {
      headers: { accept: "application/octet-stream" },
      redirect: "error",
    });
  } catch {
    return {
      ok: false,
      reason: "fetch_failed",
      message: "The curated rule-set could not be downloaded",
    };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      reason: "http_status",
      message: `The curated rule-set source responded with HTTP ${response.status}`,
    };
  }

  let body: BoundedBodyResult;
  try {
    body = await readBoundedBody(
      response,
      MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes,
    );
  } catch {
    return {
      ok: false,
      reason: "fetch_failed",
      message: "The curated rule-set download was interrupted",
    };
  }
  if (!body.ok) {
    return {
      ok: false,
      reason: "asset_too_large",
      message: "The rule-set exceeds the 512 KiB raw asset budget",
    };
  }
  if (body.bytes.byteLength === 0) {
    return {
      ok: false,
      reason: "empty_body",
      message: "The curated rule-set source returned an empty body",
    };
  }

  const sha256 = createHash("sha256").update(body.bytes).digest("hex");
  const imported = await importRuleSetAssetDraft(
    {
      ruleSetId: entry.id,
      version,
      source: entry.source,
      contentBase64: body.bytes.toString("base64"),
    },
    options.database ?? db,
  );
  if (!imported.ok) {
    return {
      ok: false,
      reason: "import_failed",
      message: imported.message,
      importReason: imported.reason,
    };
  }

  return {
    ok: true,
    ruleSetId: entry.id,
    version: imported.version,
    source: entry.source,
    url: entry.url,
    sha256,
    sizeBytes: body.bytes.byteLength,
  };
}

const fetchCuratedRuleSetSchema = z.object({
  presetId: z.string().trim().min(1).max(64),
  version: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid pinned version")
    .optional(),
});

export type FetchCuratedRuleSetInput = z.infer<
  typeof fetchCuratedRuleSetSchema
>;

export const fetchCuratedRuleSet = createServerFn({ method: "POST" })
  .middleware([
    adminAudit("networking.rule_set_fetch", {
      targetType: "managed_rule_set_asset",
      targetId: fromInput("presetId"),
    }),
  ])
  .validator(fetchCuratedRuleSetSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    return fetchAndImportCuratedRuleSet(data.presetId, {
      version: data.version,
    });
  });
