import { describe, expect, it } from "vitest";

import {
  cidrFamily,
  type CompilableRule,
  findInvalidRuleValue,
  isActionAllowedForScope,
  isValidRuleValue,
  normalizeRuleValues,
  parseRuleValuesText,
  toClashRules,
  toSingboxRouteRules,
} from "./routing-rules";

let nextId = 0;

function makeRule(overrides: Partial<CompilableRule> = {}): CompilableRule {
  nextId += 1;
  return {
    id: `rule-${String(nextId).padStart(3, "0")}`,
    enabled: true,
    sortOrder: 0,
    matchType: "domain_suffix",
    values: ["example.com"],
    action: "proxy",
    scope: "client",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("normalizeRuleValues", () => {
  it("trims, drops blanks and de-duplicates keeping first-seen order", () => {
    expect(
      normalizeRuleValues([" b.com ", "a.com", "", "   ", "b.com", "a.com"]),
    ).toEqual(["b.com", "a.com"]);
  });

  it("returns an empty list for all-blank input", () => {
    expect(normalizeRuleValues(["", "  "])).toEqual([]);
  });
});

describe("parseRuleValuesText", () => {
  it("splits on LF and CRLF, one value per line", () => {
    expect(parseRuleValuesText("a.com\r\nb.com\n\n  a.com  \nc.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
  });
});

describe("cidrFamily", () => {
  it.each([
    ["10.0.0.0/8", 4],
    ["192.168.1.0/24", 4],
    ["1.2.3.4/32", 4],
    ["fd00::/8", 6],
    ["2001:db8::/32", 6],
    ["::1/128", 6],
  ] as const)("classifies %s as IPv%i", (value, family) => {
    expect(cidrFamily(value)).toBe(family);
  });

  it.each([
    "10.0.0.0",
    "10.0.0.0/33",
    "256.0.0.0/8",
    "fd00::/129",
    "::1",
    "example.com",
    "10.0.0.0/",
    "",
    "10.0.0.0/8 ",
  ])("rejects %j", (value) => {
    expect(cidrFamily(value)).toBeNull();
  });
});

describe("isValidRuleValue", () => {
  it("accepts plain domain-style values", () => {
    for (const matchType of [
      "domain",
      "domain_suffix",
      "domain_keyword",
    ] as const) {
      expect(isValidRuleValue(matchType, "example.com")).toBe(true);
    }
  });

  it("rejects empty, whitespace-bearing and comma-bearing domain values", () => {
    for (const bad of ["", "a b.com", "a\tb.com", "a,b.com", "a.com,"]) {
      expect(isValidRuleValue("domain", bad)).toBe(false);
    }
  });

  it("requires a CIDR for ip_cidr", () => {
    expect(isValidRuleValue("ip_cidr", "10.0.0.0/8")).toBe(true);
    expect(isValidRuleValue("ip_cidr", "example.com")).toBe(false);
    expect(isValidRuleValue("ip_cidr", "10.0.0.1")).toBe(false);
  });
});

describe("findInvalidRuleValue", () => {
  it("returns the first invalid value or null", () => {
    expect(findInvalidRuleValue("domain", ["a.com", "b c", "d,e"])).toBe("b c");
    expect(
      findInvalidRuleValue("ip_cidr", ["10.0.0.0/8", "::1/128"]),
    ).toBeNull();
  });
});

describe("isActionAllowedForScope", () => {
  it("allows any action for client rules", () => {
    for (const action of ["direct", "proxy", "reject"] as const) {
      expect(isActionAllowedForScope(action, "client")).toBe(true);
    }
  });

  it("only allows reject for server and both", () => {
    for (const scope of ["server", "both"] as const) {
      expect(isActionAllowedForScope("reject", scope)).toBe(true);
      expect(isActionAllowedForScope("direct", scope)).toBe(false);
      expect(isActionAllowedForScope("proxy", scope)).toBe(false);
    }
  });
});

describe("toClashRules", () => {
  it("returns an empty list for no rules", () => {
    expect(toClashRules([])).toEqual([]);
  });

  it("maps each match type and action", () => {
    const rules = [
      makeRule({
        sortOrder: 1,
        matchType: "domain",
        values: ["a.example.com"],
        action: "direct",
      }),
      makeRule({
        sortOrder: 2,
        matchType: "domain_suffix",
        values: ["example.com"],
        action: "proxy",
      }),
      makeRule({
        sortOrder: 3,
        matchType: "domain_keyword",
        values: ["ads"],
        action: "reject",
      }),
    ];
    expect(toClashRules(rules)).toEqual([
      "DOMAIN,a.example.com,DIRECT",
      "DOMAIN-SUFFIX,example.com,PROXY",
      "DOMAIN-KEYWORD,ads,REJECT",
    ]);
  });

  it("emits one line per value", () => {
    expect(
      toClashRules([makeRule({ values: ["a.com", "b.com", "c.com"] })]),
    ).toEqual([
      "DOMAIN-SUFFIX,a.com,PROXY",
      "DOMAIN-SUFFIX,b.com,PROXY",
      "DOMAIN-SUFFIX,c.com,PROXY",
    ]);
  });

  it("uses IP-CIDR for v4 and IP-CIDR6 for v6, both with no-resolve", () => {
    expect(
      toClashRules([
        makeRule({
          matchType: "ip_cidr",
          values: ["10.0.0.0/8", "fd00::/8"],
          action: "direct",
        }),
      ]),
    ).toEqual([
      "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
      "IP-CIDR6,fd00::/8,DIRECT,no-resolve",
    ]);
  });

  it("skips disabled rules", () => {
    expect(toClashRules([makeRule({ enabled: false })])).toEqual([]);
  });

  it("includes client and both scopes but not server", () => {
    const rules = [
      makeRule({ sortOrder: 1, scope: "client", values: ["client.com"] }),
      makeRule({
        sortOrder: 2,
        scope: "both",
        action: "reject",
        values: ["both.com"],
      }),
      makeRule({
        sortOrder: 3,
        scope: "server",
        action: "reject",
        values: ["server.com"],
      }),
    ];
    expect(toClashRules(rules)).toEqual([
      "DOMAIN-SUFFIX,client.com,PROXY",
      "DOMAIN-SUFFIX,both.com,REJECT",
    ]);
  });

  it("sorts by sortOrder, then createdAt, then id, regardless of input order", () => {
    const early = new Date("2026-01-01T00:00:00.000Z");
    const late = new Date("2026-02-01T00:00:00.000Z");
    const rules = [
      makeRule({ id: "z", sortOrder: 5, values: ["z-late-order.com"] }),
      makeRule({
        id: "b",
        sortOrder: 1,
        createdAt: late,
        values: ["b-late.com"],
      }),
      makeRule({
        id: "a",
        sortOrder: 1,
        createdAt: early,
        values: ["a-early.com"],
      }),
      makeRule({
        id: "d",
        sortOrder: 1,
        createdAt: late,
        values: ["d-late.com"],
      }),
      makeRule({ id: "neg", sortOrder: -1, values: ["first.com"] }),
    ];
    const expected = [
      "DOMAIN-SUFFIX,first.com,PROXY",
      "DOMAIN-SUFFIX,a-early.com,PROXY",
      "DOMAIN-SUFFIX,b-late.com,PROXY",
      "DOMAIN-SUFFIX,d-late.com,PROXY",
      "DOMAIN-SUFFIX,z-late-order.com,PROXY",
    ];
    expect(toClashRules(rules)).toEqual(expected);
    expect(toClashRules([...rules].reverse())).toEqual(expected);
  });

  it("does not mutate its input", () => {
    const rules = [
      makeRule({ sortOrder: 2, values: ["b.com"] }),
      makeRule({ sortOrder: 1, values: ["a.com"] }),
    ];
    const snapshot = rules.map((rule) => rule.id);
    toClashRules(rules);
    expect(rules.map((rule) => rule.id)).toEqual(snapshot);
  });

  it("drops stored values that would corrupt a Clash rule string", () => {
    expect(
      toClashRules([
        makeRule({ values: ["ok.com", "bad,com", "bad com", "ok.com"] }),
        makeRule({
          matchType: "ip_cidr",
          values: ["not-a-cidr", "10.0.0.0/8"],
        }),
        makeRule({ values: ["bad,only"] }),
      ]),
    ).toEqual([
      "DOMAIN-SUFFIX,ok.com,PROXY",
      "IP-CIDR,10.0.0.0/8,PROXY,no-resolve",
    ]);
  });
});

describe("toSingboxRouteRules", () => {
  it("returns an empty list for no rules", () => {
    expect(toSingboxRouteRules([])).toEqual([]);
  });

  it("emits rule-action reject rules keyed by match type", () => {
    const rules = [
      makeRule({
        sortOrder: 1,
        scope: "server",
        action: "reject",
        matchType: "domain",
        values: ["a.example.com"],
      }),
      makeRule({
        sortOrder: 2,
        scope: "both",
        action: "reject",
        matchType: "domain_suffix",
        values: ["example.com", "example.org"],
      }),
      makeRule({
        sortOrder: 3,
        scope: "server",
        action: "reject",
        matchType: "domain_keyword",
        values: ["ads"],
      }),
      makeRule({
        sortOrder: 4,
        scope: "server",
        action: "reject",
        matchType: "ip_cidr",
        values: ["10.0.0.0/8", "fd00::/8"],
      }),
    ];
    expect(toSingboxRouteRules(rules)).toEqual([
      { domain: ["a.example.com"], action: "reject" },
      { domain_suffix: ["example.com", "example.org"], action: "reject" },
      { domain_keyword: ["ads"], action: "reject" },
      { ip_cidr: ["10.0.0.0/8", "fd00::/8"], action: "reject" },
    ]);
  });

  it("skips client-only, disabled and non-reject rules", () => {
    const rules = [
      makeRule({ scope: "client", action: "reject" }),
      makeRule({ scope: "server", action: "reject", enabled: false }),
      makeRule({ scope: "server", action: "direct" }),
      makeRule({ scope: "both", action: "proxy" }),
    ];
    expect(toSingboxRouteRules(rules)).toEqual([]);
  });

  it("orders deterministically like the Clash compiler", () => {
    const rules = [
      makeRule({
        id: "b",
        sortOrder: 2,
        scope: "server",
        action: "reject",
        values: ["b.com"],
      }),
      makeRule({
        id: "a",
        sortOrder: 1,
        scope: "server",
        action: "reject",
        values: ["a.com"],
      }),
    ];
    const expected = [
      { domain_suffix: ["a.com"], action: "reject" },
      { domain_suffix: ["b.com"], action: "reject" },
    ];
    expect(toSingboxRouteRules(rules)).toEqual(expected);
    expect(toSingboxRouteRules([...rules].reverse())).toEqual(expected);
  });

  it("omits rules left without any valid value", () => {
    expect(
      toSingboxRouteRules([
        makeRule({
          scope: "server",
          action: "reject",
          matchType: "ip_cidr",
          values: ["nope"],
        }),
      ]),
    ).toEqual([]);
  });
});
