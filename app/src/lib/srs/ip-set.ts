import { ByteReader, ByteWriter } from "./bytes";
import { srsError } from "./errors";

export interface IpRange {
  family: 4 | 6;
  from: bigint;
  to: bigint;
}

export interface IPSet {
  ranges: IpRange[];
}

const IPV4_BITS = 32;
const IPV6_BITS = 128;

function familyBits(family: 4 | 6): number {
  return family === 4 ? IPV4_BITS : IPV6_BITS;
}

function parseIPv4(value: string, path?: string): bigint {
  const parts = value.split(".");
  if (parts.length !== 4) {
    throw srsError("invalid_cidr", path, "IPv4 address needs four octets");
  }

  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw srsError("invalid_cidr", path, "invalid IPv4 octet");
    }
    if (part.length > 1 && part.startsWith("0")) {
      throw srsError(
        "invalid_cidr",
        path,
        "IPv4 octets may not have leading zeros",
      );
    }
    const octet = Number(part);
    if (octet > 255) {
      throw srsError("invalid_cidr", path, "IPv4 octet out of range");
    }
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIPv6(value: string, path?: string): bigint {
  if (value.includes(".")) {
    throw srsError(
      "invalid_cidr",
      path,
      "IPv4-in-IPv6 addresses are not supported",
    );
  }
  if (value.includes("%")) {
    throw srsError("invalid_cidr", path, "IPv6 zones are not supported");
  }

  const compression = value.indexOf("::");
  if (compression !== -1 && compression !== value.lastIndexOf("::")) {
    throw srsError("invalid_cidr", path, "multiple IPv6 :: groups");
  }

  let groups: string[];
  if (compression === -1) {
    groups = value.split(":");
    if (groups.length !== 8) {
      throw srsError("invalid_cidr", path, "IPv6 address needs eight groups");
    }
  } else {
    const left = value.slice(0, compression);
    const right = value.slice(compression + 2);
    const leftGroups = left === "" ? [] : left.split(":");
    const rightGroups = right === "" ? [] : right.split(":");
    const provided = leftGroups.length + rightGroups.length;
    if (provided >= 8) {
      throw srsError("invalid_cidr", path, "IPv6 :: must omit a group");
    }
    groups = [
      ...leftGroups,
      ...Array.from({ length: 8 - provided }, () => "0"),
      ...rightGroups,
    ];
  }

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      throw srsError("invalid_cidr", path, "invalid IPv6 group");
    }
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

function parseAddress(
  value: string,
  path?: string,
): {
  family: 4 | 6;
  address: bigint;
} {
  if (value.split(":").length > 1) {
    return { family: 6, address: parseIPv6(value, path) };
  }
  return { family: 4, address: parseIPv4(value, path) };
}

export function parseIpRange(value: string, path?: string): IpRange {
  const trimmed = value.trim();
  if (trimmed === "") throw srsError("invalid_cidr", path, "empty CIDR");

  const parts = trimmed.split("/");
  if (parts.length > 2) {
    throw srsError("invalid_cidr", path, "multiple CIDR prefixes");
  }

  const parsed = parseAddress(parts[0]!, path);
  const width = familyBits(parsed.family);
  let prefix = width;
  if (parts.length === 2) {
    const rawPrefix = parts[1]!;
    if (!/^\d{1,3}$/.test(rawPrefix)) {
      throw srsError("invalid_cidr", path, "invalid CIDR prefix");
    }
    if (rawPrefix.length > 1 && rawPrefix.startsWith("0")) {
      throw srsError(
        "invalid_cidr",
        path,
        "CIDR prefix may not have leading zeros",
      );
    }
    prefix = Number(rawPrefix);
    if (prefix > width) {
      throw srsError("invalid_cidr", path, "CIDR prefix out of range");
    }
  }

  const hostBits = width - prefix;
  const mask =
    hostBits === width
      ? 0n
      : ((1n << BigInt(width)) - 1n) ^ ((1n << BigInt(hostBits)) - 1n);
  const from = parsed.address & mask;
  const to = from | ((1n << BigInt(hostBits)) - 1n);
  return { family: parsed.family, from, to };
}

export function mergeIpRanges(ranges: readonly IpRange[]): IpRange[] {
  const result: IpRange[] = [];
  for (const family of [4, 6] as const) {
    const familyRanges = ranges
      .filter((range) => range.family === family)
      .sort((left, right) =>
        left.from < right.from ? -1 : left.from > right.from ? 1 : 0,
      );
    for (const range of familyRanges) {
      const previous = result.at(-1);
      if (
        previous &&
        previous.family === family &&
        range.from <= previous.to + 1n
      ) {
        if (range.to > previous.to) previous.to = range.to;
        continue;
      }
      result.push({ ...range });
    }
  }
  return result;
}

function trailingZeroBits(value: bigint, width: number): number {
  if (value === 0n) return width;
  let result = 0;
  let remaining = value;
  while (result < width && (remaining & 1n) === 0n) {
    result++;
    remaining >>= 1n;
  }
  return result;
}

function formatIPv4(value: bigint): string {
  const octets: number[] = [];
  let remaining = value;
  for (let index = 0; index < 4; index++) {
    octets.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return octets.join(".");
}

function formatIPv6(value: bigint): string {
  const groups: number[] = [];
  let remaining = value;
  for (let index = 0; index < 8; index++) {
    groups.unshift(Number(remaining & 0xffffn));
    remaining >>= 16n;
  }

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index++;
      continue;
    }
    const start = index;
    while (index < groups.length && groups[index] === 0) index++;
    const length = index - start;
    if (length >= 2 && length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }

  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(":");
  const before = hex.slice(0, bestStart).join(":");
  const after = hex.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

export function formatIpRangeCidr(range: IpRange, prefixBits: number): string {
  const address =
    range.family === 4 ? formatIPv4(range.from) : formatIPv6(range.from);
  return `${address}/${prefixBits}`;
}

export function rangeToCidrs(range: IpRange): string[] {
  const width = familyBits(range.family);
  const result: string[] = [];
  let from = range.from;
  while (from <= range.to) {
    let blockBits = trailingZeroBits(from, width);
    while (blockBits > 0 && from + (1n << BigInt(blockBits)) - 1n > range.to) {
      blockBits--;
    }
    result.push(formatIpRangeCidr({ ...range, from }, width - blockBits));
    from += 1n << BigInt(blockBits);
  }
  return result;
}

export function rangesToCidrs(ranges: readonly IpRange[]): string[] {
  return mergeIpRanges(ranges).flatMap(rangeToCidrs);
}

export function buildIPSet(values: readonly string[], path?: string): IPSet {
  return {
    ranges: mergeIpRanges(
      values.map((value, index) =>
        parseIpRange(value, path ? `${path}[${index}]` : undefined),
      ),
    ),
  };
}

export function normalizeCidrList(
  values: readonly string[],
  path?: string,
): string[] {
  return rangesToCidrs(buildIPSet(values, path).ranges);
}

function addressBytes(value: bigint, family: 4 | 6): Uint8Array {
  const length = family === 4 ? 4 : 16;
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

export function writeIPSet(writer: ByteWriter, set: IPSet): void {
  const ranges = mergeIpRanges(set.ranges);
  writer.writeByte(1);
  writer.writeU64BE(BigInt(ranges.length));
  for (const family of [4, 6] as const) {
    const length = family === 4 ? 4 : 16;
    for (const range of ranges) {
      if (range.family !== family) continue;
      if (range.from > range.to) {
        throw srsError("invalid_cidr", undefined, "range start exceeds end");
      }
      writer.writeUvarint(length);
      writer.writeBytes(addressBytes(range.from, family));
      writer.writeUvarint(length);
      writer.writeBytes(addressBytes(range.to, family));
    }
  }
}

export function readIPSet(reader: ByteReader): IPSet {
  const version = reader.readU8();
  if (version !== 1) {
    throw srsError("invalid_field", undefined, "unsupported IP set version");
  }

  const rawCount = reader.readU64BE();
  if (rawCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw srsError("invalid_field", undefined, "IP set range count too large");
  }
  const count = Number(rawCount);
  if (count > reader.remaining) throw srsError("truncated");

  const ranges: IpRange[] = [];
  for (let index = 0; index < count; index++) {
    const fromLength = reader.readUvarintNumber();
    if (fromLength !== 4 && fromLength !== 16) {
      throw srsError(
        "invalid_field",
        undefined,
        "invalid IP set address length",
      );
    }
    const from = bytesToBigInt(reader.readBytes(fromLength));
    const toLength = reader.readUvarintNumber();
    if (toLength !== fromLength) {
      throw srsError(
        "invalid_field",
        undefined,
        "mismatched IP set range widths",
      );
    }
    const to = bytesToBigInt(reader.readBytes(toLength));
    if (from > to) {
      throw srsError(
        "invalid_field",
        undefined,
        "IP set range start exceeds end",
      );
    }
    ranges.push({ family: fromLength === 4 ? 4 : 6, from, to });
  }

  return { ranges: mergeIpRanges(ranges) };
}
