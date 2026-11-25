import { describe, expect, test } from "vitest";

import { ByteReader, ByteWriter, compareBytes, reverseBytes } from "./bytes";
import { SrsError } from "./errors";

function encodeUvarint(value: number | bigint): string {
  const writer = new ByteWriter();
  writer.writeUvarint(value);
  return [...writer.toBytes()]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

describe("ByteWriter and ByteReader", () => {
  test.each([
    [0n, "00"],
    [1n, "01"],
    [127n, "7f"],
    [128n, "80 01"],
    [300n, "ac 02"],
    [16383n, "ff 7f"],
    [16384n, "80 80 01"],
    [2n ** 32n, "80 80 80 80 10"],
    [2n ** 53n - 1n, "ff ff ff ff ff ff ff 0f"],
  ])("writes uvarint %s", (value, expected) => {
    expect(encodeUvarint(value)).toBe(expected);
  });

  test("round-trips uvarint boundaries", () => {
    for (const value of [
      0n,
      1n,
      127n,
      128n,
      300n,
      16383n,
      16384n,
      2n ** 32n,
      2n ** 53n - 1n,
    ]) {
      const writer = new ByteWriter();
      writer.writeUvarint(value);
      const reader = new ByteReader(writer.toBytes());
      expect(reader.readUvarint()).toBe(value);
      expect(reader.remaining).toBe(0);
    }
  });

  test("writes fixed-width big-endian integers", () => {
    const writer = new ByteWriter();
    writer.writeU16BE(0x1234);
    writer.writeU32BE(0x12345678);
    writer.writeU64BE(0x0102030405060708n);
    expect([...writer.toBytes()]).toEqual([
      0x12, 0x34, 0x12, 0x34, 0x56, 0x78, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
      0x07, 0x08,
    ]);

    const reader = new ByteReader(writer.toBytes());
    expect(reader.readU16BE()).toBe(0x1234);
    expect(reader.readU32BE()).toBe(0x12345678);
    expect(reader.readU64BE()).toBe(0x0102030405060708n);
    expect(reader.remaining).toBe(0);
  });

  test("grows a dense buffer without losing bytes", () => {
    const writer = new ByteWriter(1);
    for (let index = 0; index < 10_000; index++) {
      writer.writeU8(index & 0xff);
    }
    const bytes = writer.toBytes();
    expect(bytes).toHaveLength(10_000);
    expect(bytes[0]).toBe(0);
    expect(bytes[9_999]).toBe(9_999 & 0xff);
  });

  test.each([
    ["u8", Uint8Array.of(), (reader: ByteReader) => reader.readU8()],
    ["u16", Uint8Array.of(1), (reader: ByteReader) => reader.readU16BE()],
    ["u32", Uint8Array.of(1, 2, 3), (reader: ByteReader) => reader.readU32BE()],
    ["u64", Uint8Array.of(1, 2, 3), (reader: ByteReader) => reader.readU64BE()],
    [
      "uvarint",
      Uint8Array.of(0x80),
      (reader: ByteReader) => reader.readUvarint(),
    ],
    ["bytes", Uint8Array.of(1), (reader: ByteReader) => reader.readBytes(3)],
  ])("reports truncation for %s", (_name, bytes, read) => {
    const reader = new ByteReader(bytes);
    expect(() => read(reader)).toThrowError(
      expect.objectContaining({ code: "truncated" }),
    );
  });

  test("rejects an overlong uvarint", () => {
    const reader = new ByteReader(Uint8Array.from({ length: 10 }, () => 0x80));
    expect(() => reader.readUvarint()).toThrowError(
      expect.objectContaining({ code: "invalid_field" }),
    );
  });

  test("rejects out-of-range scalar writes", () => {
    const writer = new ByteWriter();
    expect(() => writer.writeU8(256)).toThrowError(SrsError);
    expect(() => writer.writeU16BE(-1)).toThrowError(SrsError);
    expect(() => writer.writeU64BE(1n << 64n)).toThrowError(SrsError);
  });

  test("compares and reverses byte arrays", () => {
    const left = Uint8Array.of(1, 2, 3);
    const right = Uint8Array.of(1, 2, 4);
    expect(compareBytes(left, right)).toBeLessThan(0);
    expect(compareBytes(right, left)).toBeGreaterThan(0);
    expect(compareBytes(left, Uint8Array.of(1, 2))).toBeGreaterThan(0);
    expect([...reverseBytes(left)]).toEqual([3, 2, 1]);
  });
});
