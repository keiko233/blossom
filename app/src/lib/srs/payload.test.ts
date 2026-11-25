import { describe, expect, test } from "vitest";

import { decodePayload, encodePayload, parseRuleSetSource } from "./payload";
import type { RuleSetSource } from "./types";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function randomInt(random: () => number, max: number): number {
  return Math.floor(random() * max);
}

function randomRule(random: () => number): RuleSetSource["rules"][number] {
  const rule: RuleSetSource["rules"][number] = { type: "default" };
  if (random() < 0.5) {
    rule.domain = Array.from({ length: 1 + randomInt(random, 4) }, () =>
      pick(random, [
        "example.com",
        "a.example.com",
        "bücher.example",
        "test.org",
        "x.y.z",
      ]),
    );
  }
  if (random() < 0.5) {
    rule.domain_suffix = Array.from({ length: 1 + randomInt(random, 3) }, () =>
      pick(random, ["example.com", ".example.org", "cn", ".net"]),
    );
  }
  if (random() < 0.3) rule.domain_keyword = [pick(random, ["google", "cdn"])];
  if (random() < 0.2) rule.domain_regex = ["^ads?\\."];
  if (random() < 0.4) {
    rule.ip_cidr = [
      pick(random, ["10.0.0.0/8", "192.0.2.0/24", "2001:db8::/32"]),
    ];
  }
  if (random() < 0.3) {
    rule.source_ip_cidr = ["172.16.0.0/12"];
  }
  if (random() < 0.3) rule.port = [pick(random, [80, 443, 8080])];
  if (random() < 0.2) rule.port_range = ["1000:2000"];
  if (random() < 0.3) rule.network = [pick(random, ["tcp", "udp", "icmp"])];
  if (random() < 0.1) rule.invert = true;

  const hasItems = Object.keys(rule).some((key) => key !== "type");
  if (!hasItems) rule.domain = ["fallback.example"];
  if (random() < 0.25) {
    return {
      type: "logical",
      mode: random() < 0.5 ? "and" : "or",
      rules: [rule, { type: "default", domain: ["logical.example"] }],
      ...(random() < 0.2 ? { invert: true } : {}),
    };
  }
  return rule;
}

describe("payload", () => {
  test("is deterministic for shuffled and duplicated inputs", () => {
    const first = encodePayload({
      rules: [
        {
          domain: ["B.example", "a.example", "b.example"],
          domain_suffix: ["Example.com", "example.com"],
          port: [443, 80, 443],
          ip_cidr: ["192.0.2.1/24", "192.0.2.0/24"],
        },
      ],
    });
    const second = encodePayload({
      rules: [
        {
          ip_cidr: ["192.0.2.0/24"],
          port: [80, 443],
          domain_suffix: ["example.com"],
          domain: ["a.example", "b.example"],
        },
      ],
    });
    expect([...first]).toEqual([...second]);
  });

  test("round-trips logical rules and invert flags", () => {
    const source: RuleSetSource = {
      rules: [
        {
          type: "logical",
          mode: "or",
          invert: true,
          rules: [
            { type: "default", domain: ["example.com"], invert: true },
            {
              type: "logical",
              mode: "and",
              rules: [
                { type: "default", port: [443] },
                { type: "default", network: ["tcp"] },
              ],
            },
          ],
        },
      ],
    };
    expect(decodePayload(encodePayload(source))).toEqual(source);
  });

  test("canonicalizes a default rule envelope", () => {
    expect(
      parseRuleSetSource({
        rules: [{ type: "default", domain: "Example.com." }],
      }),
    ).toEqual({ rules: [{ type: "default", domain: ["example.com"] }] });
  });

  test("accepts a bare rule array", () => {
    expect(parseRuleSetSource([{ domain: ["example.com"] }])).toEqual({
      rules: [{ type: "default", domain: ["example.com"] }],
    });
  });

  test("rejects unsupported and unknown fields", () => {
    expect(() =>
      parseRuleSetSource({ rules: [{ query_type: [1] }] }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_field" }));
    expect(() =>
      parseRuleSetSource({ rules: [{ made_up: true }] }),
    ).toThrowError(expect.objectContaining({ code: "invalid_field" }));
  });

  test("reports a JSON-path-like path", () => {
    expect(() =>
      parseRuleSetSource({
        rules: [{ domain: ["good.example", "bad/example"] }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_domain",
        path: "rules[0].domain[1]",
      }),
    );
  });

  test("rejects empty rules", () => {
    expect(() => parseRuleSetSource({ rules: [{}] })).toThrowError(
      expect.objectContaining({ code: "empty_rule" }),
    );
    expect(() =>
      parseRuleSetSource({
        rules: [{ type: "logical", mode: "and", rules: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: "empty_rule" }));
  });

  test("enforces per-field and total value limits", () => {
    expect(() =>
      parseRuleSetSource({
        rules: [
          {
            domain: Array.from(
              { length: 20_001 },
              (_value, index) => `d${index}.example`,
            ),
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "too_many_values" }));

    expect(() =>
      parseRuleSetSource({
        rules: Array.from({ length: 3 }, () => ({
          domain: Array.from(
            { length: 20_000 },
            (_value, index) => `d${index}.example`,
          ),
        })),
      }),
    ).toThrowError(expect.objectContaining({ code: "too_many_values" }));
  });

  test("enforces the top-level rule and logical depth limits", () => {
    expect(() =>
      parseRuleSetSource({
        rules: Array.from({ length: 65 }, () => ({ port: [80] })),
      }),
    ).toThrowError(expect.objectContaining({ code: "too_many_values" }));

    let nested: unknown = { port: [80] };
    for (let index = 0; index < 9; index++) {
      nested = { type: "logical", mode: "and", rules: [nested] };
    }
    expect(() => parseRuleSetSource({ rules: [nested] })).toThrowError(
      expect.objectContaining({ code: "too_deep" }),
    );
  });

  test("decodes exactly 200 seeded random sources", () => {
    const random = seededRandom(0x5eed_c0de);
    for (let index = 0; index < 200; index++) {
      const rules = Array.from({ length: 1 + randomInt(random, 3) }, () =>
        randomRule(random),
      );
      const source = parseRuleSetSource({ rules });
      expect(decodePayload(encodePayload(source))).toEqual(source);
    }
  });
});
