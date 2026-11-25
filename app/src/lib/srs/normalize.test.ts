import { describe, expect, test } from "vitest";

import {
  normalizeDomain,
  normalizeDomainSuffix,
  normalizeKeyword,
  normalizeNetwork,
  normalizePort,
  normalizePortRange,
  normalizeRegex,
  uniqueSorted,
} from "./normalize";

describe("normalization", () => {
  test.each([
    ["Example.COM", "example.com"],
    [" example.com. ", "example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["_acme-challenge.example.com", "_acme-challenge.example.com"],
    ["a-b.example", "a-b.example"],
  ])("normalizes domain %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  test.each([
    "",
    "  ",
    "example.com/",
    "user@example.com",
    "example.com:443",
    "example..com",
    ".example.com",
    "exa mple.com",
    "*",
    `${"a".repeat(64)}.com`,
    Array.from({ length: 128 }, () => "a").join("."),
  ])("rejects invalid domain %s", (input) => {
    expect(() => normalizeDomain(input)).toThrowError(
      expect.objectContaining({ code: "invalid_domain" }),
    );
  });

  test("normalizes domain suffixes and preserves one leading dot", () => {
    expect(normalizeDomainSuffix("Example.COM")).toBe("example.com");
    expect(normalizeDomainSuffix(".Example.COM.")).toBe(".example.com");
    expect(normalizeDomainSuffix("bücher.example")).toBe(
      "xn--bcher-kva.example",
    );
  });

  test.each(["", ".", "..example.com", "example.com/", "*.example.com"])(
    "rejects invalid suffix %s",
    (input) => {
      expect(() => normalizeDomainSuffix(input)).toThrowError(
        expect.objectContaining({ code: "invalid_domain" }),
      );
    },
  );

  test("normalizes keywords", () => {
    expect(normalizeKeyword("  Google  ")).toBe("google");
    expect(normalizeKeyword("a".repeat(128))).toHaveLength(128);
    expect(() => normalizeKeyword(" ")).toThrowError(
      expect.objectContaining({ code: "invalid_field" }),
    );
    expect(() => normalizeKeyword("a".repeat(129))).toThrowError(
      expect.objectContaining({ code: "invalid_field" }),
    );
  });

  test("normalizes ports and ranges", () => {
    expect(normalizePort(443)).toBe(443);
    expect(normalizePort(" 80 ")).toBe(80);
    expect(normalizePortRange("443:443")).toBe("443:443");
    expect(normalizePortRange(":80")).toBe("1:80");
    expect(normalizePortRange("1000:")).toBe("1000:65535");
    for (const value of [0, 65_536, 1.5, "http"]) {
      expect(() => normalizePort(value)).toThrowError(
        expect.objectContaining({ code: "invalid_port" }),
      );
    }
    for (const value of ["", ":", "80", "80:79", "0:80", "80:0"]) {
      expect(() => normalizePortRange(value)).toThrowError(
        expect.objectContaining({ code: "invalid_port" }),
      );
    }
  });

  test("normalizes the network enum", () => {
    expect(normalizeNetwork(" TCP ")).toBe("tcp");
    expect(normalizeNetwork("udp")).toBe("udp");
    expect(normalizeNetwork("icmp")).toBe("icmp");
    expect(() => normalizeNetwork("quic")).toThrowError(
      expect.objectContaining({ code: "invalid_field" }),
    );
  });

  test("accepts RE2-compatible regular expressions", () => {
    expect(normalizeRegex(" ^ads?\\. ")).toBe("^ads?\\.");
    expect(normalizeRegex("(?:foo|bar)+")).toBe("(?:foo|bar)+");
  });

  test.each([
    "",
    "(",
    "(?=lookahead)",
    "(?!negative)",
    "(?<=lookbehind)",
    "(?<!negative)",
    "(?>atomic)",
    "a*+",
    "a++",
    "a?+",
    "(a)\\1",
    "(?<name>a)\\k<name>",
  ])("rejects unsupported or invalid regex %s", (input) => {
    expect(() => normalizeRegex(input)).toThrowError(
      expect.objectContaining({ code: "invalid_regex" }),
    );
  });

  test("sorts and deduplicates mixed primitives", () => {
    expect(uniqueSorted([3, 1, 2, 1])).toEqual([1, 2, 3]);
    expect(uniqueSorted(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});
