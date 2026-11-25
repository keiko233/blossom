import { srsError } from "./errors";

const MAX_UINT64 = (1n << 64n) - 1n;

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a !== b) return a - b;
  }
  return left.length - right.length;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function reverseBytes(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    result[value.length - 1 - index] = value[index]!;
  }
  return result;
}

export class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 64) {
    this.buffer = new Uint8Array(Math.max(initialCapacity, 1));
  }

  get size(): number {
    return this.length;
  }

  writeByte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw srsError("invalid_field", undefined, "byte out of range");
    }
    this.ensure(1);
    this.buffer[this.length++] = value;
  }

  writeU8(value: number): void {
    this.writeByte(value);
  }

  writeU16BE(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw srsError("invalid_field", undefined, "u16 out of range");
    }
    this.ensure(2);
    this.buffer[this.length++] = value >>> 8;
    this.buffer[this.length++] = value & 0xff;
  }

  writeU32BE(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw srsError("invalid_field", undefined, "u32 out of range");
    }
    this.ensure(4);
    this.buffer[this.length++] = (value >>> 24) & 0xff;
    this.buffer[this.length++] = (value >>> 16) & 0xff;
    this.buffer[this.length++] = (value >>> 8) & 0xff;
    this.buffer[this.length++] = value & 0xff;
  }

  writeU64BE(value: bigint): void {
    if (value < 0n || value > MAX_UINT64) {
      throw srsError("invalid_field", undefined, "u64 out of range");
    }
    this.ensure(8);
    let remaining = value;
    for (let index = 7; index >= 0; index--) {
      this.buffer[this.length + index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.length += 8;
  }

  writeUvarint(value: number | bigint): void {
    let remaining = typeof value === "bigint" ? value : BigInt(value);
    if (remaining < 0n) {
      throw srsError("invalid_field", undefined, "negative uvarint");
    }
    do {
      let byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining !== 0n) byte |= 0x80;
      this.writeByte(byte);
    } while (remaining !== 0n);
  }

  writeBytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private ensure(extra: number): void {
    const required = this.length + extra;
    if (required <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }
}

export class ByteReader {
  private readonly bytes: Uint8Array;
  private index = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get offset(): number {
    return this.index;
  }

  get remaining(): number {
    return this.bytes.length - this.index;
  }

  readU8(): number {
    if (this.remaining < 1) throw srsError("truncated");
    return this.bytes[this.index++]!;
  }

  readU16BE(): number {
    if (this.remaining < 2) throw srsError("truncated");
    const value = this.bytes[this.index]! * 0x100 + this.bytes[this.index + 1]!;
    this.index += 2;
    return value;
  }

  readU32BE(): number {
    if (this.remaining < 4) throw srsError("truncated");
    const value =
      this.bytes[this.index]! * 0x1000000 +
      this.bytes[this.index + 1]! * 0x10000 +
      this.bytes[this.index + 2]! * 0x100 +
      this.bytes[this.index + 3]!;
    this.index += 4;
    return value;
  }

  readU64BE(): bigint {
    if (this.remaining < 8) throw srsError("truncated");
    let value = 0n;
    for (let index = 0; index < 8; index++) {
      value = (value << 8n) | BigInt(this.bytes[this.index + index]!);
    }
    this.index += 8;
    return value;
  }

  readUvarint(): bigint {
    let value = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count++) {
      const byte = this.readU8();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw srsError("invalid_field", undefined, "uvarint too long");
  }

  readUvarintNumber(): number {
    const value = this.readUvarint();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw srsError("invalid_field", undefined, "uvarint out of range");
    }
    return Number(value);
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw srsError("invalid_field", undefined, "invalid byte length");
    }
    if (length > this.remaining) throw srsError("truncated");
    const value = this.bytes.slice(this.index, this.index + length);
    this.index += length;
    return value;
  }
}
