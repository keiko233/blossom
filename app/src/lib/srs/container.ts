import { isSrsError, srsError } from "./errors";

export const SRS_WRITE_VERSION = 1;
export const SRS_MAX_READ_VERSION = 5;
export const SRS_MAX_FILE_BYTES = 524_288;
export const SRS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const MAGIC = Uint8Array.of(0x53, 0x52, 0x53);

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

function checkMagic(file: Uint8Array): void {
  if (
    file.length < MAGIC.length ||
    file[0] !== MAGIC[0] ||
    file[1] !== MAGIC[1] ||
    file[2] !== MAGIC[2]
  ) {
    throw srsError("invalid_magic");
  }
}

export async function packSrs(
  payload: Uint8Array,
  version = SRS_WRITE_VERSION,
): Promise<Uint8Array> {
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > SRS_MAX_READ_VERSION
  ) {
    throw srsError("unsupported_version", undefined, String(version));
  }

  const compressed = await new Response(
    new Blob([blobPart(payload)])
      .stream()
      .pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();
  const result = new Uint8Array(MAGIC.length + 1 + compressed.byteLength);
  result.set(MAGIC, 0);
  result[MAGIC.length] = version;
  result.set(new Uint8Array(compressed), MAGIC.length + 1);
  return result;
}

async function inflateBounded(
  compressed: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  const source = new Blob([blobPart(compressed)]).stream();
  const reader = source
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw srsError("payload_too_large", undefined, `over ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (isSrsError(error)) throw error;
    throw srsError("inflate_failed");
  }

  return concat(chunks, total);
}

export async function unpackSrs(
  file: Uint8Array,
): Promise<{ version: number; payload: Uint8Array }> {
  if (file.length > SRS_MAX_FILE_BYTES) throw srsError("file_too_large");
  checkMagic(file);
  if (file.length < MAGIC.length + 2) throw srsError("truncated");
  const version = file[MAGIC.length]!;
  if (version < 1 || version > SRS_MAX_READ_VERSION) {
    throw srsError("unsupported_version", undefined, String(version));
  }
  const payload = await inflateBounded(
    file.subarray(MAGIC.length + 1),
    SRS_MAX_PAYLOAD_BYTES,
  );
  return { version, payload };
}
