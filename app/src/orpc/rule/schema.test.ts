import { describe, expect, it } from "vitest";

import {
  createRuleSchema,
  getRuleIssues,
  reorderRulesSchema,
  updateRuleSchema,
} from "./schema";

const valid = {
  name: "Block ads",
  matchType: "domain_suffix" as const,
  values: ["ads.example.com"],
  action: "reject" as const,
};

describe("createRuleSchema", () => {
  it("applies defaults for enabled and scope and leaves sortOrder unset", () => {
    const parsed = createRuleSchema.parse(valid);
    expect(parsed).toEqual({
      ...valid,
      enabled: true,
      scope: "client",
    });
    expect(parsed.sortOrder).toBeUndefined();
  });

  it("trims and de-duplicates values", () => {
    const parsed = createRuleSchema.parse({
      ...valid,
      values: [" a.com ", "b.com", "a.com", "  "],
    });
    expect(parsed.values).toEqual(["a.com", "b.com"]);
  });

  it("requires at least one value", () => {
    expect(createRuleSchema.safeParse({ ...valid, values: [] }).success).toBe(
      false,
    );
    expect(
      createRuleSchema.safeParse({ ...valid, values: ["  ", ""] }).success,
    ).toBe(false);
  });

  it("requires a name", () => {
    expect(createRuleSchema.safeParse({ ...valid, name: "  " }).success).toBe(
      false,
    );
  });

  it("rejects domain values with whitespace or commas", () => {
    for (const bad of ["a b.com", "a,b.com"]) {
      expect(
        createRuleSchema.safeParse({ ...valid, values: [bad] }).success,
      ).toBe(false);
    }
  });

  it("validates ip_cidr values as IPv4/IPv6 CIDRs", () => {
    const base = { ...valid, matchType: "ip_cidr" as const };
    expect(
      createRuleSchema.safeParse({
        ...base,
        values: ["10.0.0.0/8", "fd00::/8"],
      }).success,
    ).toBe(true);
    for (const bad of [
      "10.0.0.1",
      "10.0.0.0/33",
      "example.com",
      "fd00::/200",
    ]) {
      expect(
        createRuleSchema.safeParse({ ...base, values: [bad] }).success,
      ).toBe(false);
    }
  });

  it("requires reject for server and both scopes", () => {
    for (const scope of ["server", "both"] as const) {
      expect(
        createRuleSchema.safeParse({ ...valid, scope, action: "direct" })
          .success,
      ).toBe(false);
      expect(
        createRuleSchema.safeParse({ ...valid, scope, action: "proxy" })
          .success,
      ).toBe(false);
      expect(
        createRuleSchema.safeParse({ ...valid, scope, action: "reject" })
          .success,
      ).toBe(true);
    }
  });

  it("allows any action for client scope", () => {
    for (const action of ["direct", "proxy", "reject"] as const) {
      expect(
        createRuleSchema.safeParse({ ...valid, scope: "client", action })
          .success,
      ).toBe(true);
    }
  });

  it("rejects unknown enum values", () => {
    expect(
      createRuleSchema.safeParse({ ...valid, matchType: "regex" }).success,
    ).toBe(false);
    expect(
      createRuleSchema.safeParse({ ...valid, scope: "everywhere" }).success,
    ).toBe(false);
  });
});

describe("updateRuleSchema", () => {
  it("accepts an enabled-only toggle", () => {
    expect(updateRuleSchema.parse({ id: "r1", enabled: false })).toEqual({
      id: "r1",
      enabled: false,
    });
  });

  it("requires an id", () => {
    expect(updateRuleSchema.safeParse({ enabled: false }).success).toBe(false);
  });

  it("normalizes values when provided", () => {
    expect(
      updateRuleSchema.parse({ id: "r1", values: [" a.com ", "a.com"] }).values,
    ).toEqual(["a.com"]);
  });

  it("checks value format only when the match type is submitted too", () => {
    expect(
      updateRuleSchema.safeParse({
        id: "r1",
        matchType: "ip_cidr",
        values: ["example.com"],
      }).success,
    ).toBe(false);
    // matchType unknown here; updateRule re-checks the merged row.
    expect(
      updateRuleSchema.safeParse({ id: "r1", values: ["example.com"] }).success,
    ).toBe(true);
  });

  it("rejects a non-reject action submitted with a server scope", () => {
    expect(
      updateRuleSchema.safeParse({ id: "r1", scope: "server", action: "proxy" })
        .success,
    ).toBe(false);
  });
});

describe("getRuleIssues", () => {
  it("reports nothing for a consistent merged rule", () => {
    expect(
      getRuleIssues({
        matchType: "ip_cidr",
        values: ["10.0.0.0/8"],
        action: "reject",
        scope: "both",
      }),
    ).toEqual([]);
  });

  it("reports value and action issues with their paths", () => {
    const issues = getRuleIssues({
      matchType: "domain",
      values: ["bad value"],
      action: "direct",
      scope: "server",
    });
    expect(issues.map((issue) => issue.path)).toEqual(["values", "action"]);
  });

  it("stays silent about combinations it cannot see", () => {
    expect(getRuleIssues({ scope: "server" })).toEqual([]);
    expect(getRuleIssues({ values: ["a b"] })).toEqual([]);
  });
});

describe("reorderRulesSchema", () => {
  it("accepts a list of distinct ids", () => {
    expect(reorderRulesSchema.parse({ ids: ["a", "b"] }).ids).toEqual([
      "a",
      "b",
    ]);
  });

  it("rejects empty lists and duplicate ids", () => {
    expect(reorderRulesSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(reorderRulesSchema.safeParse({ ids: ["a", "a"] }).success).toBe(
      false,
    );
  });
});
