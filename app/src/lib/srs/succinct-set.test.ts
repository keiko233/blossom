import { describe, expect, test } from "vitest";

import { ByteReader, ByteWriter } from "./bytes";
import {
  buildSuccinctSet,
  decodeDomainKeys,
  domainKeys,
  listKeys,
  readSuccinctSet,
  writeSuccinctSet,
} from "./succinct-set";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function keys(values: readonly string[]): Uint8Array[] {
  return values.map((value) => encoder.encode(value));
}

function strings(values: readonly Uint8Array[]): string[] {
  return values.map((value) => decoder.decode(value));
}

describe("succinct set", () => {
  test("builds a single key with the expected words", () => {
    const set = buildSuccinctSet(keys(["a"]));
    expect(set.leaves).toEqual([0b10n]);
    expect(set.bitmap).toEqual([0b110n]);
    expect([...set.labels]).toEqual(["a".charCodeAt(0)]);
  });

  test("builds a shared prefix with the expected words", () => {
    const set = buildSuccinctSet(keys(["a", "ab", "b"]));
    expect(set.leaves).toEqual([0b1110n]);
    expect(set.bitmap).toEqual([0b1110100n]);
    expect([...set.labels]).toEqual([
      "a".charCodeAt(0),
      "b".charCodeAt(0),
      "b".charCodeAt(0),
    ]);
  });

  test("handles an empty-leaf trie", () => {
    const set = buildSuccinctSet(keys(["ab"]));
    expect(set.leaves).toEqual([0b100n]);
    expect(set.bitmap).toEqual([0b11010n]);

    const writer = new ByteWriter();
    writeSuccinctSet(writer, set);
    const reader = new ByteReader(writer.toBytes());
    const decoded = readSuccinctSet(reader);
    expect(strings(listKeys(decoded))).toEqual(["ab"]);
    expect(reader.remaining).toBe(0);
  });

  test("sorts, deduplicates and reverses the key list", () => {
    const set = buildSuccinctSet(keys(["b", "a", "ab", "a"]));
    expect(strings(listKeys(set)).sort()).toEqual(["a", "ab", "b"]);
  });

  test("round-trips a realistic key list", () => {
    const values = ["com", "example.com", "www.example.com", "\r.example.com"];
    const writer = new ByteWriter();
    writeSuccinctSet(writer, buildSuccinctSet(keys(values)));
    const reader = new ByteReader(writer.toBytes());
    expect(strings(listKeys(readSuccinctSet(reader))).sort()).toEqual(
      [...values].sort(),
    );
    expect(reader.remaining).toBe(0);
  });

  test("pads leaves from a writer that omits zero words", () => {
    const writer = new ByteWriter();
    writer.writeU8(0);
    writer.writeUvarint(0);
    writer.writeUvarint(1);
    writer.writeU64BE(0b11100n);
    writer.writeUvarint(2);
    writer.writeBytes(Uint8Array.of(0x61, 0x62));
    const set = readSuccinctSet(new ByteReader(writer.toBytes()));
    expect(set.leaves).toEqual([0n]);
    expect(listKeys(set)).toEqual([]);
  });

  test("round-trips an empty set", () => {
    const writer = new ByteWriter();
    writeSuccinctSet(writer, buildSuccinctSet([]));
    const reader = new ByteReader(writer.toBytes());
    expect(listKeys(readSuccinctSet(reader))).toEqual([]);
    expect(reader.remaining).toBe(0);
  });

  test.each([
    ["zero words without a terminator", [0n], 0],
    ["too many zeros", [0b110n], 2],
    ["four-word label mismatch", [0b101n], 0],
  ])("rejects malformed bitmap: %s", (_name, bitmap, labelCount) => {
    const writer = new ByteWriter();
    writer.writeU8(0);
    writer.writeUvarint(1);
    writer.writeU64BE(1n);
    writer.writeUvarint(bitmap.length);
    for (const word of bitmap) writer.writeU64BE(word);
    writer.writeUvarint(labelCount);
    if (labelCount > 0) {
      writer.writeBytes(new Uint8Array(labelCount).fill(0x61));
    }
    expect(() =>
      readSuccinctSet(new ByteReader(writer.toBytes())),
    ).toThrowError(expect.objectContaining({ code: "invalid_field" }));
  });

  test("decodes legacy suffix keys and collapses exact/suffix pairs", () => {
    expect(
      decodeDomainKeys(
        keys([
          reverse("example.com"),
          reverse("\r.example.com"),
          reverse("\r.example.net"),
        ]),
      ),
    ).toEqual({
      domains: [],
      suffixes: [".example.net", "example.com"],
    });
  });

  test("decodes root-label suffix keys", () => {
    expect(
      decodeDomainKeys(
        keys([reverse("example.com"), reverse("\nexample.com")]),
      ),
    ).toEqual({
      domains: ["example.com"],
      suffixes: ["example.com"],
    });
  });

  test("builds legacy keys from domains and suffixes", () => {
    const decoded = decodeDomainKeys(
      domainKeys(
        ["example.com", "www.example.com"],
        ["example.com", ".example.com"],
      ),
    );
    expect(decoded.domains).toEqual(["www.example.com"]);
    expect(decoded.suffixes).toEqual(["example.com"]);
  });
});

function reverse(value: string): string {
  return [...value].reverse().join("");
}
