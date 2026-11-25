import { describe, expect, it } from "vitest";

import {
  deriveRuleSetId,
  deriveRuleSetVersion,
  deriveSource,
  filterCatalogTree,
  officialFileName,
  officialRuleSetUrls,
  parseOfficialName,
  readBodyCapped,
  ruleSetOrigin,
  suggestRuleSetVersion,
} from "./github-rule-set-catalog";

const SHA = "8b8788649349cf73fcd12fc81a5cae580e60360c";

describe("parseOfficialName", () => {
  it.each([
    "cn",
    "us",
    "acer@cn",
    "airchina@!cn",
    "category-ads-all",
    "a",
    "a".repeat(80),
  ])("accepts %s", (name) => {
    expect(parseOfficialName("geosite", name)).toBe(name);
    expect(parseOfficialName("geoip", name)).toBe(name);
  });

  it.each([
    "../x",
    "a/b",
    "a%2fb",
    "A",
    "",
    "a".repeat(81),
    "中文",
    "cn ",
    " cn",
    "-cn",
    "cn.srs",
    "cn?x=1",
    "cn#frag",
  ])("rejects %j", (name) => {
    expect(parseOfficialName("geosite", name)).toBeNull();
  });

  it("rejects non-string input and unknown repos", () => {
    expect(parseOfficialName("geosite", undefined)).toBeNull();
    expect(parseOfficialName("geosite", 42)).toBeNull();
    expect(parseOfficialName("other" as never, "cn")).toBeNull();
  });
});

describe("official file names and URLs", () => {
  it("builds only allowlisted hosts, repos and refs", () => {
    const file = officialFileName("geosite", "airchina@!cn");
    expect(file).toBe("geosite-airchina@!cn.srs");
    expect(officialRuleSetUrls("geosite", file, SHA)).toBe(
      `https://raw.githubusercontent.com/SagerNet/sing-geosite/${SHA}/${file}`,
    );
    expect(officialRuleSetUrls("geoip", "geoip-cn.srs")).toBe(
      "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
    );
  });

  it("rejects a non-commit ref and a mismatched repo prefix", () => {
    expect(() =>
      officialRuleSetUrls("geosite", "geosite-cn.srs", "../../main"),
    ).toThrow();
    expect(() =>
      officialRuleSetUrls("geosite", "geosite-cn.srs", "8B87886"),
    ).toThrow();
    expect(() =>
      officialRuleSetUrls("geosite", "geosite-cn.srs", "a".repeat(64)),
    ).toThrow();
    expect(() => officialRuleSetUrls("geosite", "geoip-cn.srs")).toThrow();
    expect(() => officialRuleSetUrls("geoip", "geosite-cn.srs")).toThrow();
    expect(() => officialRuleSetUrls("geosite", "geosite-../x.srs")).toThrow();
  });
});

describe("ids, versions and provenance", () => {
  it("derives ids and keeps them within the 64-character cap", () => {
    expect(deriveRuleSetId("geosite", "cn")).toBe("geosite-cn");
    expect(deriveRuleSetId("geosite", "acer@cn")).toBe("geosite-acer-at-cn");
    expect(deriveRuleSetId("geosite", "airchina@!cn")).toBe(
      "geosite-airchina-at-not-cn",
    );
    expect(deriveRuleSetId("geoip", "cn")).toBe("geoip-cn");
    expect(() => deriveRuleSetId("geosite", "a".repeat(60))).toThrow();
  });

  it("uses the UTC commit date and short SHA", () => {
    expect(deriveRuleSetVersion("2026-11-25T07:44:54Z", SHA)).toBe(
      "2026.11.25-8b87886",
    );
    expect(deriveRuleSetVersion("2026-01-02T00:00:00.000Z", SHA)).toBe(
      "2026.01.02-8b87886",
    );
    expect(() => deriveRuleSetVersion("not a date", SHA)).toThrow();
    expect(() => deriveRuleSetVersion("2026-11-25T00:00:00Z", "abc")).toThrow();
    expect(() =>
      deriveRuleSetVersion("2026-11-25T00:00:00Z", "b".repeat(64)),
    ).not.toThrow();
    expect(deriveRuleSetVersion("2026-11-25T00:00:00Z", "c".repeat(64))).toBe(
      `2026.11.25-${"c".repeat(7)}`,
    );
  });

  it("builds a bounded source string", () => {
    const source = deriveSource("geosite", SHA, "geosite-cn.srs");
    expect(source).toBe(`github:SagerNet/sing-geosite@${SHA}/geosite-cn.srs`);
    expect(source.length).toBeLessThanOrEqual(512);
    expect(deriveSource("geoip", "c".repeat(64), "geoip-cn.srs")).toBe(
      `github:SagerNet/sing-geoip@${"c".repeat(64)}/geoip-cn.srs`,
    );
    expect(() =>
      deriveSource("geoip", "c".repeat(41), "geoip-cn.srs"),
    ).toThrow();
  });
});

describe("filterCatalogTree", () => {
  it("keeps valid root blobs, drops the rest and sorts by name", () => {
    expect(
      filterCatalogTree([
        { path: "geosite-us.srs", type: "blob", size: 10 },
        { path: "geosite-cn.srs", type: "blob", size: 20 },
        { path: "geosite-acer@cn.srs", type: "blob", size: 1 },
        { path: "geosite-tree.srs", type: "tree", size: 10 },
        { path: "geosite-bad.srs", type: "blob", size: 0 },
        { path: "geosite-big.srs", type: "blob", size: 524_289 },
        { path: "geosite-ok.srs", type: "blob", size: 524_288 },
        { path: "nested/geosite-x.srs", type: "blob", size: 1 },
        { path: "geosite-UPPER.srs", type: "blob", size: 1 },
        { path: "geoip-cn.json", type: "blob", size: 1 },
        { path: "geosite-no-size.srs", type: "blob" },
      ]),
    ).toEqual([
      { name: "acer@cn", file: "geosite-acer@cn.srs", sizeBytes: 1 },
      { name: "cn", file: "geosite-cn.srs", sizeBytes: 20 },
      { name: "ok", file: "geosite-ok.srs", sizeBytes: 524_288 },
      { name: "us", file: "geosite-us.srs", sizeBytes: 10 },
    ]);
  });
});

describe("ruleSetOrigin", () => {
  it("classifies the three origins and odd inputs", () => {
    expect(
      ruleSetOrigin(`github:SagerNet/sing-geoip@${SHA}/geoip-cn.srs`),
    ).toBe("official");
    expect(ruleSetOrigin("custom:json")).toBe("custom");
    expect(ruleSetOrigin("custom:structured")).toBe("custom");
    expect(ruleSetOrigin("upload:manual")).toBe("upload");
    expect(ruleSetOrigin("")).toBe("upload");
    expect(ruleSetOrigin("github:someone/else")).toBe("upload");
  });
});

describe("suggestRuleSetVersion", () => {
  it("increments integer-only versions", () => {
    expect(suggestRuleSetVersion([])).toBe("1");
    expect(suggestRuleSetVersion(["1"])).toBe("2");
    expect(suggestRuleSetVersion(["3", "1", "2"])).toBe("4");
  });

  it("uses a UTC date for dates or mixed versions", () => {
    expect(suggestRuleSetVersion(["2026.11.25"])).toMatch(
      /^\d{4}\.\d{2}\.\d{2}$/,
    );
    expect(suggestRuleSetVersion(["1", "2026.11.25"])).toMatch(
      /^\d{4}\.\d{2}\.\d{2}$/,
    );
  });
});

describe("readBodyCapped", () => {
  it("rejects a declared content-length over the limit", async () => {
    const response = new Response(new Uint8Array(4), {
      headers: { "content-length": "4" },
    });
    expect(await readBodyCapped(response, 3)).toEqual({
      ok: false,
      reason: "asset_too_large",
    });
  });

  it("stops a body that grows past the limit without a content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.enqueue(new Uint8Array(2));
        controller.close();
      },
    });
    const response = new Response(stream);
    expect(await readBodyCapped(response, 3)).toEqual({
      ok: false,
      reason: "asset_too_large",
    });
  });

  it("accepts exactly the limit and rejects empty bodies", async () => {
    const exact = await readBodyCapped(new Response(new Uint8Array(3)), 3);
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.bytes).toEqual(new Uint8Array(3));

    expect(await readBodyCapped(new Response(new Uint8Array(0)), 3)).toEqual({
      ok: false,
      reason: "upstream_invalid_asset",
    });
  });
});
