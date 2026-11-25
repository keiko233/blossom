import {
  ByteReader,
  ByteWriter,
  compareBytes,
  concatBytes,
  reverseBytes,
} from "./bytes";
import { srsError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SuccinctSet {
  leaves: bigint[];
  bitmap: bigint[];
  labels: Uint8Array;
}

export function buildSuccinctSet(keys: readonly Uint8Array[]): SuccinctSet {
  const sorted = [...keys]
    .filter((key) => key.length > 0)
    .sort(compareBytes)
    .filter(
      (key, index, all) =>
        index === 0 || compareBytes(key, all[index - 1]!) !== 0,
    );

  const leaves: bigint[] = [];
  const bitmap: bigint[] = [];
  const labels: number[] = [];
  let bitmapIndex = 0;

  const setBit = (words: bigint[], index: number, value: 0 | 1) => {
    while (index >>> 6 >= words.length) words.push(0n);
    words[index >>> 6]! |= BigInt(value) << BigInt(index & 63);
  };

  interface QueueEntry {
    start: number;
    end: number;
    column: number;
  }

  const queue: QueueEntry[] = [{ start: 0, end: sorted.length, column: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]!;
    let start = entry.start;
    if (entry.column === sorted[entry.start]?.length) {
      start++;
      setBit(leaves, index, 1);
    }

    for (let next = start; next < entry.end;) {
      const groupStart = next;
      const label = sorted[groupStart]![entry.column]!;
      while (next < entry.end && sorted[next]![entry.column] === label) {
        next++;
      }
      queue.push({
        start: groupStart,
        end: next,
        column: entry.column + 1,
      });
      labels.push(label);
      setBit(bitmap, bitmapIndex++, 0);
    }
    setBit(bitmap, bitmapIndex++, 1);
  }

  return { leaves, bitmap, labels: Uint8Array.from(labels) };
}

export function writeSuccinctSet(writer: ByteWriter, set: SuccinctSet): void {
  writer.writeByte(0);
  writer.writeUvarint(set.leaves.length);
  for (const word of set.leaves) writer.writeU64BE(word);
  writer.writeUvarint(set.bitmap.length);
  for (const word of set.bitmap) writer.writeU64BE(word);
  writer.writeUvarint(set.labels.length);
  writer.writeBytes(set.labels);
}

function readU64Words(reader: ByteReader): bigint[] {
  const count = reader.readUvarintNumber();
  if (count > reader.remaining / 8) throw srsError("truncated");
  return Array.from({ length: count }, () => reader.readU64BE());
}

function getBit(words: readonly bigint[], index: number): boolean {
  const word = words[index >>> 6];
  if (word === undefined) return false;
  return ((word >> BigInt(index & 63)) & 1n) === 1n;
}

function countBitmap(words: readonly bigint[]): {
  ones: number;
  zeros: number;
} {
  let ones = 0;
  let lastOne = -1;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex]!;
    let remaining = word;
    while (remaining !== 0n) {
      remaining &= remaining - 1n;
      ones++;
    }
    if (word !== 0n) {
      lastOne = wordIndex * 64 + word.toString(2).length - 1;
    }
  }
  return { ones, zeros: lastOne + 1 - ones };
}

export function readSuccinctSet(reader: ByteReader): SuccinctSet {
  const version = reader.readU8();
  if (version !== 0) {
    throw srsError(
      "invalid_field",
      undefined,
      "unsupported succinct set version",
    );
  }

  const leaves = readU64Words(reader);
  const bitmap = readU64Words(reader);
  const labelLength = reader.readUvarintNumber();
  const labels = reader.readBytes(labelLength);
  const { ones, zeros } = countBitmap(bitmap);
  if (ones !== zeros + 1 || labels.length !== zeros) {
    throw srsError("invalid_field", undefined, "malformed succinct set");
  }

  const requiredLeaves = (ones + 63) >>> 6;
  while (leaves.length < requiredLeaves) leaves.push(0n);
  return { leaves, bitmap, labels };
}

export function listKeys(set: SuccinctSet): Uint8Array[] {
  const keys: Uint8Array[] = [];

  interface Node {
    key: Uint8Array;
  }

  const queue: Node[] = [{ key: new Uint8Array() }];
  let bitmapIndex = 0;
  let labelIndex = 0;
  for (let nodeIndex = 0; nodeIndex < queue.length; nodeIndex++) {
    const node = queue[nodeIndex]!;
    if (getBit(set.leaves, nodeIndex)) keys.push(node.key);
    while (!getBit(set.bitmap, bitmapIndex)) {
      if (labelIndex >= set.labels.length) {
        throw srsError(
          "invalid_field",
          undefined,
          "malformed succinct set labels",
        );
      }
      queue.push({
        key: concatBytes([node.key, Uint8Array.of(set.labels[labelIndex++]!)]),
      });
      bitmapIndex++;
    }
    bitmapIndex++;
  }
  return keys;
}

export function domainKeys(
  domains: readonly string[],
  suffixes: readonly string[],
): Uint8Array[] {
  const keys: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const suffix of suffixes) {
    if (seen.has(suffix)) continue;
    seen.add(suffix);
    if (suffix.startsWith(".")) {
      keys.push(reverseBytes(encoder.encode(`\r${suffix}`)));
    } else {
      keys.push(reverseBytes(encoder.encode(suffix)));
      const prefixed = `.${suffix}`;
      if (!seen.has(prefixed)) {
        seen.add(prefixed);
        keys.push(reverseBytes(encoder.encode(`\r${prefixed}`)));
      }
    }
  }
  for (const domain of domains) {
    if (seen.has(domain)) continue;
    seen.add(domain);
    keys.push(reverseBytes(encoder.encode(domain)));
  }
  return keys;
}

export function decodeDomainKeys(keys: readonly Uint8Array[]): {
  domains: string[];
  suffixes: string[];
} {
  const domainSet = new Set<string>();
  const suffixSet = new Set<string>();
  for (const key of keys) {
    const reversed = decoder.decode(reverseBytes(key));
    if (reversed.startsWith("\r")) {
      suffixSet.add(reversed.slice(1));
    } else if (reversed.startsWith("\n")) {
      suffixSet.add(reversed.slice(1));
    } else {
      domainSet.add(reversed);
    }
  }

  for (const suffix of suffixSet) {
    if (!suffix.startsWith(".")) continue;
    const root = suffix.slice(1);
    if (domainSet.has(root)) {
      domainSet.delete(root);
      suffixSet.delete(suffix);
      suffixSet.add(root);
    }
  }

  return {
    domains: [...domainSet].sort(),
    suffixes: [...suffixSet].sort(),
  };
}
