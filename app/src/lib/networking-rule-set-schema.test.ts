import { describe, expect, it } from "vitest";

import {
  customRuleSetInputSchema,
  importOfficialRuleSetSchema,
} from "./networking-rule-set-schema";
import { importRuleSetAssetSchema } from "./networking-schema";

describe("importOfficialRuleSetSchema", () => {
  it.each([
    { repo: "geosite", name: "cn" },
    { repo: "geosite", name: "airchina@!cn" },
    { repo: "geoip", name: "us" },
  ])("accepts %j", (input) => {
    expect(importOfficialRuleSetSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    { repo: "geosite", name: "../x" },
    { repo: "geosite", name: "cn/../../x" },
    { repo: "geosite", name: "a/b" },
    { repo: "geosite", name: "a%2fb" },
    { repo: "geosite", name: "A" },
    { repo: "geosite", name: "" },
    { repo: "geosite", name: "a".repeat(81) },
    { repo: "geosite", name: "中文" },
    { repo: "other", name: "cn" },
    { name: "cn" },
  ])("rejects %j", (input) => {
    expect(importOfficialRuleSetSchema.safeParse(input).success).toBe(false);
  });
});

describe("customRuleSetInputSchema", () => {
  const base = {
    ruleSetId: "custom-domains",
    version: "1",
    mode: "structured" as const,
  };

  it("accepts structured and JSON rules", () => {
    expect(
      customRuleSetInputSchema.safeParse({
        ...base,
        rules: { rules: [{ domain_suffix: ["example.com"] }] },
      }).success,
    ).toBe(true);
    expect(
      customRuleSetInputSchema.safeParse({
        ...base,
        mode: "json",
        rules: [{ domain: "example.com" }],
      }).success,
    ).toBe(true);
  });

  it("trims id/version and uses the shared asset regexes", () => {
    expect(
      customRuleSetInputSchema.safeParse({
        ...base,
        ruleSetId: "  custom-domains  ",
        version: "  2026.11.26  ",
        rules: [],
      }),
    ).toMatchObject({
      success: true,
      data: { ruleSetId: "custom-domains", version: "2026.11.26" },
    });

    const accepted = importRuleSetAssetSchema.pick({
      ruleSetId: true,
      version: true,
    });
    for (const input of [
      { ruleSetId: "Upper", version: "1" },
      { ruleSetId: "custom-domains", version: "-1" },
      { ruleSetId: "custom/domains", version: "1" },
      { ruleSetId: "a".repeat(65), version: "1" },
      { ruleSetId: "", version: "1" },
    ]) {
      expect(accepted.safeParse(input).success).toBe(false);
      expect(
        customRuleSetInputSchema.safeParse({ ...base, ...input, rules: [] })
          .success,
      ).toBe(false);
    }
  });

  it("rejects an over-1-MiB serialized rule payload", () => {
    const oversized = "x".repeat(1024 * 1024);
    expect(
      customRuleSetInputSchema.safeParse({
        ...base,
        rules: [{ domain_keyword: [oversized] }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-JSON rules and unknown modes", () => {
    expect(
      customRuleSetInputSchema.safeParse({
        ...base,
        mode: "source",
        rules: [],
      }).success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      customRuleSetInputSchema.safeParse({ ...base, rules: cyclic }).success,
    ).toBe(false);
  });
});
