import { describe, expect, test } from "vitest";

import { ByteReader, ByteWriter } from "./bytes";
import {
  buildIPSet,
  mergeIpRanges,
  parseIpRange,
  rangeToCidrs,
  rangesToCidrs,
  readIPSet,
  writeIPSet,
} from "./ip-set";
import type { IpRange } from "./ip-set";

const CONFIG_RS_PAYLOAD = Uint8Array.from([
  0x01, 0x00, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04,
  0xc0, 0x00, 0x02, 0x00, 0x04, 0xc0, 0x00, 0x02, 0xff, 0xff, 0x00,
]);

function cidrsOf(values: readonly string[]): string[] {
  return buildIPSet(values).ranges.flatMap(rangeToCidrs);
}

describe("IP set", () => {
  test("decodes the pinned Rust sample", () => {
    const reader = new ByteReader(CONFIG_RS_PAYLOAD.subarray(3));
    expect(rangesToCidrs(readIPSet(reader).ranges)).toEqual(["192.0.2.0/24"]);
    expect(reader.remaining).toBe(2);
  });

  test("re-encodes the pinned Rust sample byte for byte", () => {
    const set = buildIPSet(["192.0.2.0/24"]);
    const writer = new ByteWriter();
    writeIPSet(writer, set);
    expect([...writer.toBytes()]).toEqual([
      ...CONFIG_RS_PAYLOAD.subarray(3, -2),
    ]);
  });

  test("masks host bits and accepts bare addresses", () => {
    expect(cidrsOf(["192.0.2.129/24"])).toEqual(["192.0.2.0/24"]);
    expect(cidrsOf(["192.0.2.129"])).toEqual(["192.0.2.129/32"]);
  });

  test("merges overlap and adjacency", () => {
    const ranges = mergeIpRanges([
      parseIpRange("10.0.0.0/24"),
      parseIpRange("10.0.1.0/24"),
      parseIpRange("10.0.0.128/25"),
      parseIpRange("10.0.4.0/24"),
    ]);
    expect(ranges).toHaveLength(2);
    expect(rangesToCidrs(ranges)).toEqual(["10.0.0.0/23", "10.0.4.0/24"]);
  });

  test("emits IPv4 before IPv6 regardless of input order", () => {
    const set = buildIPSet(["2001:db8::/32", "192.0.2.0/24"]);
    const writer = new ByteWriter();
    writeIPSet(writer, set);
    const reader = new ByteReader(writer.toBytes());
    expect(reader.readU8()).toBe(1);
    expect(reader.readU64BE()).toBe(2n);
    expect(reader.readUvarint()).toBe(4n);
    expect([...reader.readBytes(4)]).toEqual([192, 0, 2, 0]);
  });

  test("handles IPv6 compression forms", () => {
    expect(cidrsOf(["2001:db8::/32"])).toEqual(["2001:db8::/32"]);
    expect(cidrsOf(["::1"])).toEqual(["::1/128"]);
    expect(cidrsOf(["::/0"])).toEqual(["::/0"]);
    expect(cidrsOf(["2001:0db8:0000:0000:0000:0000:0000:0000/32"])).toEqual([
      "2001:db8::/32",
    ]);
  });

  test("range to minimal CIDRs covers the whole range", () => {
    const range: IpRange = {
      family: 4,
      from: 0xc0000201n,
      to: 0xc0000206n,
    };
    expect(rangeToCidrs(range)).toEqual([
      "192.0.2.1/32",
      "192.0.2.2/31",
      "192.0.2.4/31",
      "192.0.2.6/32",
    ]);
  });

  test("round-trips merged ranges through the wire encoding", () => {
    const values = [
      "10.0.0.0/8",
      "192.168.0.0/16",
      "172.16.0.0/12",
      "2001:db8::/32",
      "::1/128",
    ];
    const set = buildIPSet(values);
    const writer = new ByteWriter();
    writeIPSet(writer, set);
    const reader = new ByteReader(writer.toBytes());
    expect(readIPSet(reader)).toEqual(set);
    expect(reader.remaining).toBe(0);
  });

  test.each([
    "",
    "  ",
    "192.0.2",
    "192.0.2.256",
    "192.0.2.01",
    "192.0.2.0/33",
    "192.0.2.0/024",
    "192.0.2.0/24/8",
    "::ffff:192.0.2.1",
    "fe80::1%eth0",
    "2001:db8::/129",
    "2001:db8::1::2",
    "2001:db8:::1",
    "2001:db8::/",
  ])("rejects invalid CIDR %s", (value) => {
    expect(() => parseIpRange(value)).toThrowError(
      expect.objectContaining({ code: "invalid_cidr" }),
    );
  });
});
