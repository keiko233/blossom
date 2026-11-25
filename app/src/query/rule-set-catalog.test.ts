import { MANAGED_SNAPSHOT_BYTE_BUDGETS } from "@blossom/domain/managed-networking";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/db";
import {
  CURATED_RULE_SET_CATALOG,
  findCuratedRuleSetEntry,
  isCuratedRuleSetUrl,
} from "@/lib/rule-set-catalog";

const inserted: Record<string, unknown>[] = [];
let insertErrorCode: string | null = null;

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    let parse = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (schema: { parse: (input: unknown) => unknown }) => {
        parse = (input) => schema.parse(input);
        return builder;
      },
      handler:
        (fn: (context: { data: unknown }) => unknown) =>
        (arg?: { data: unknown }) =>
          Promise.resolve().then(() => fn({ data: parse(arg?.data) })),
    };
    return builder;
  };
  return { createServerFn, createServerOnlyFn: (fn: unknown) => fn };
});

vi.mock("@/lib/admin-audit-middleware", () => ({
  adminAudit: () => async (context: unknown) => context,
}));
vi.mock("@/lib/ensure-admin", () => ({
  ensureAdmin: async () => ({ user: { id: "admin", role: "admin" } }),
}));
vi.mock("@/db", () => ({
  db: {},
  getDatabaseDriver: () => "node-postgres",
}));

import { fetchAndImportCuratedRuleSet } from "./rule-set-catalog";

function fakeDatabase(): Database {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (insertErrorCode) {
            const error = Object.assign(new Error("duplicate"), {
              code: insertErrorCode,
            });
            throw error;
          }
          inserted.push(values);
          return [values];
        },
      }),
    }),
  } as unknown as Database;
}

function neverFetch() {
  return vi.fn(() => {
    throw new Error("fetch must not run for an unknown preset");
  });
}

function responseWith(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes as unknown as BodyInit, { status });
}

const fetchMock = (bytes: Uint8Array, status = 200) =>
  vi.fn(async () => responseWith(bytes, status)) as unknown as typeof fetch;

beforeEach(() => {
  inserted.length = 0;
  insertErrorCode = null;
});

describe("curated rule-set catalog", () => {
  it("pins unique ids, provenance and official SagerNet URLs", () => {
    expect(new Set(CURATED_RULE_SET_CATALOG.map((e) => e.id)).size).toBe(
      CURATED_RULE_SET_CATALOG.length,
    );
    for (const entry of CURATED_RULE_SET_CATALOG) {
      expect(entry.id).toMatch(/^[a-z0-9._-]+$/);
      expect(entry.url).toBe(
        `https://raw.githubusercontent.com/${
          entry.source.startsWith("SagerNet/sing-geoip")
            ? "SagerNet/sing-geoip"
            : "SagerNet/sing-geosite"
        }/rule-set/${entry.id}.srs`,
      );
      expect(isCuratedRuleSetUrl(entry.url)).toBe(true);
      expect(entry.source).not.toMatch(/https?:|file:/);
      expect(entry.defaultVersion).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });

  it("covers speedtest, AI, streaming, regional and private needs", () => {
    expect(CURATED_RULE_SET_CATALOG.map((entry) => entry.id)).toEqual([
      "geosite-category-speedtest",
      "geosite-openai",
      "geosite-anthropic",
      "geosite-netflix",
      "geosite-disney",
      "geosite-google",
      "geoip-cn",
      "geosite-cn",
      "geoip-private",
      "geosite-private",
    ]);
  });

  it("looks up entries without accepting derived or unknown ids", () => {
    expect(findCuratedRuleSetEntry("geosite-openai")?.category).toBe("ai");
    expect(
      findCuratedRuleSetEntry("https://evil.example/x.srs"),
    ).toBeUndefined();
    expect(
      isCuratedRuleSetUrl("https://evil.example/rule-set/geoip-cn.srs"),
    ).toBe(false);
    expect(
      isCuratedRuleSetUrl(
        "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/../../evil.srs",
      ),
    ).toBe(false);
  });
});

describe("fetchAndImportCuratedRuleSet", () => {
  it("rejects unknown presets before touching the network", async () => {
    const fetchImpl = neverFetch() as unknown as typeof fetch;
    const result = await fetchAndImportCuratedRuleSet("not-in-catalog", {
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: "unknown_preset" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches the catalog URL, hashes and imports the bytes", async () => {
    const entry = findCuratedRuleSetEntry("geosite-openai")!;
    const bytes = new TextEncoder().encode("fake-srs");
    const fetchImpl = fetchMock(bytes);
    const result = await fetchAndImportCuratedRuleSet("geosite-openai", {
      fetchImpl,
      database: fakeDatabase(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(entry.url, {
      headers: { accept: "application/octet-stream" },
      redirect: "error",
    });
    expect(result).toMatchObject({
      ok: true,
      ruleSetId: "geosite-openai",
      version: entry.defaultVersion,
      source: entry.source,
      url: entry.url,
      sizeBytes: bytes.byteLength,
    });
    expect(inserted[0]).toMatchObject({
      ruleSetId: "geosite-openai",
      version: entry.defaultVersion,
      format: "binary",
      source: entry.source,
      sizeBytes: bytes.byteLength,
      contentBase64: Buffer.from(bytes).toString("base64"),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("honours an explicit pinned version", async () => {
    const fetchImpl = fetchMock(new Uint8Array([1, 2, 3]));
    const result = await fetchAndImportCuratedRuleSet("geoip-cn", {
      fetchImpl,
      version: "2026.11.26",
      database: fakeDatabase(),
    });

    expect(result).toMatchObject({ ok: true, version: "2026.11.26" });
    expect(inserted[0]).toMatchObject({ version: "2026.11.26" });
  });

  it("rejects a non-200 response before reading or importing", async () => {
    const fetchImpl = fetchMock(new Uint8Array([1]), 404);
    const result = await fetchAndImportCuratedRuleSet("geoip-cn", {
      fetchImpl,
      database: fakeDatabase(),
    });

    expect(result).toMatchObject({ ok: false, reason: "http_status" });
    expect(inserted).toEqual([]);
  });

  it("rejects an empty body", async () => {
    const fetchImpl = fetchMock(new Uint8Array(0));
    const result = await fetchAndImportCuratedRuleSet("geosite-disney", {
      fetchImpl,
      database: fakeDatabase(),
    });

    expect(result).toMatchObject({ ok: false, reason: "empty_body" });
    expect(inserted).toEqual([]);
  });

  it("rejects a body over the 512 KiB raw budget", async () => {
    const fetchImpl = fetchMock(
      new Uint8Array(MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes + 1),
    );
    const result = await fetchAndImportCuratedRuleSet("geosite-netflix", {
      fetchImpl,
      database: fakeDatabase(),
    });

    expect(result).toMatchObject({ ok: false, reason: "asset_too_large" });
    expect(inserted).toEqual([]);
  });

  it("surfaces the writer's duplicate reason as an import failure", async () => {
    insertErrorCode = "23505";
    const fetchImpl = fetchMock(new Uint8Array([1]));
    const result = await fetchAndImportCuratedRuleSet("geosite-google", {
      fetchImpl,
      database: fakeDatabase(),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "import_failed",
      importReason: "duplicate_rule_set",
    });
  });

  it("fails closed when the download itself throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await fetchAndImportCuratedRuleSet("geoip-private", {
      fetchImpl,
      database: fakeDatabase(),
    });

    expect(result).toMatchObject({ ok: false, reason: "fetch_failed" });
  });
});
