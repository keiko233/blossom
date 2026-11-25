import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { unpackSrs } from "./container";
import { compileRuleSet, inspectSrs } from "./index";
import { decodePayload, encodePayload } from "./payload";

interface Fixture {
  file: string;
  sha256: string;
  bytes: number;
}

const FIXTURES: Fixture[] = [
  {
    file: "geosite-category-ads-all.srs",
    sha256: "5744f0691898c4b91d236f7f2dcb4dc0095149b80a6345a613c6fa28edcba7d1",
    bytes: 8_175,
  },
  {
    file: "geoip-cn.srs",
    sha256: "29ed29ad2fee7a60dc1a94d73d6812a277e02aff46822689c8368be9caf45ed8",
    bytes: 34_259,
  },
  {
    file: "geosite-0x0.srs",
    sha256: "57342f4dc81d936af60bfaf191ea27cad7c7e3b73b8288b7b5eadcd40aef66da",
    bytes: 46,
  },
  {
    file: "geosite-4chan.srs",
    sha256: "7020ca3f58634650a8945fe3701fdb529a9466a4f8d249338c61f021481293fc",
    bytes: 65,
  },
  {
    file: "geoip-aq.srs",
    sha256: "bfbf0dfe9eeefcb0a25d8be101dbd699efb1f56605526a1b61cfc4adf08f9f60",
    bytes: 63,
  },
  {
    file: "config-rs-sample.srs",
    sha256: "92d8d10d7a32dca08ff48c4e79a671d79abea67a25a7c6d14b4d77097d0693ca",
    bytes: 34,
  },
];

function readFixture(file: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url)),
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

describe("golden SRS fixtures", () => {
  test.each(FIXTURES)(
    "$file matches its recorded digest and size",
    async ({ file, sha256, bytes }) => {
      const value = readFixture(file);
      expect(value.length).toBe(bytes);
      const hashInput = new Uint8Array(value.length);
      hashInput.set(value);
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        hashInput,
      );
      expect(
        [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      ).toBe(sha256);
    },
  );

  test.each(FIXTURES)(
    "$file decodes and re-encodes byte for byte",
    async ({ file }) => {
      const source = readFixture(file);
      const { version, payload } = await unpackSrs(source);
      expect(version).toBe(1);
      const encoded = encodePayload(decodePayload(payload));
      expect(encoded.length).toBe(payload.length);
      expect(bytesEqual(encoded, payload)).toBe(true);
    },
  );

  test("inspects the pinned Rust sample stats", async () => {
    const summary = await inspectSrs(readFixture("config-rs-sample.srs"));
    expect(summary).toEqual({
      version: 1,
      payloadBytes: 24,
      stats: {
        rules: 1,
        domains: 0,
        suffixes: 0,
        keywords: 0,
        regexes: 0,
        cidrs: 1,
        ports: 0,
        ranges: 0,
      },
    });
  });

  test("inspects a larger official file", async () => {
    const summary = await inspectSrs(readFixture("geoip-cn.srs"));
    expect(summary.version).toBe(1);
    expect(summary.payloadBytes).toBeGreaterThan(100_000);
    expect(summary.stats?.rules).toBe(1);
    expect(summary.stats?.cidrs).toBeGreaterThan(1_000);
  });
});

describe("compileRuleSet", () => {
  test("compiles a mixed rule set end to end", async () => {
    const compiled = await compileRuleSet({
      version: 99,
      rules: [
        {
          domain: ["Example.COM"],
          domain_suffix: [".Example.ORG", "example.net"],
          domain_keyword: ["Ads"],
          domain_regex: ["^tracker\\."],
          ip_cidr: ["192.0.2.129/24", "2001:db8::/32"],
          source_ip_cidr: ["172.16.0.1"],
          port: [443, 80, 443],
          port_range: ["1000:2000", ":80"],
          source_port: [53],
          source_port_range: ["2000:"],
          network: ["TCP"],
        },
        {
          type: "logical",
          mode: "or",
          invert: true,
          rules: [
            { domain: ["logical.example"] },
            { ip_cidr: ["198.51.100.0/24"] },
          ],
        },
      ],
    });

    expect(compiled.version).toBe(1);
    expect([...compiled.bytes.subarray(0, 5)]).toEqual([
      0x53, 0x52, 0x53, 0x01, 0x78,
    ]);
    expect(compiled.bytes.length).toBeLessThan(524_288);
    expect(compiled.payloadBytes).toBeGreaterThan(0);
    expect(compiled.stats).toEqual({
      rules: 4,
      domains: 2,
      suffixes: 2,
      keywords: 1,
      regexes: 1,
      cidrs: 4,
      ports: 3,
      ranges: 3,
    });

    const summary = await inspectSrs(compiled.bytes);
    expect(summary.version).toBe(1);
    expect(summary.payloadBytes).toBe(compiled.payloadBytes);
    expect(summary.stats).toEqual(compiled.stats);
  });

  test("produces deterministic bytes for equivalent inputs", async () => {
    const first = await compileRuleSet({
      rules: [{ port: [443, 80], domain: ["b.example", "a.example"] }],
    });
    const second = await compileRuleSet({
      rules: [{ domain: ["A.EXAMPLE", "b.example"], port: [80, 443] }],
    });
    expect(bytesEqual(first.bytes, second.bytes)).toBe(true);
  });
});
