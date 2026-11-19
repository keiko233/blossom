import { AGENT_WS_V2_LIMITS } from "@blossom/contracts/agent-ws-v2";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export interface ConfigSnapshotLimits {
  maxSnapshotBytes: number;
  snapshotChunkBytes: number;
}

export type ConfigSnapshotEncoding =
  | {
      ok: true;
      totalBytes: number;
      /** Lowercase hex SHA-256 of the complete body bytes. */
      digest: string;
      /** Standard base64 of each consecutive chunk, in order. */
      chunks: string[];
    }
  | { ok: false; code: "snapshot_too_large"; totalBytes: number };

/**
 * Serializes a configuration document into the bounded body the agent
 * verifies before applying. The body is the HTTP v3 JSON, so the digest and
 * chunks cover exactly what `GET /agent/config/v3` would return. Oversized
 * documents are refused rather than truncated; the caller reports them.
 */
export function encodeConfigSnapshot(
  document: unknown,
  limits: ConfigSnapshotLimits = AGENT_WS_V2_LIMITS,
): ConfigSnapshotEncoding {
  const body = new TextEncoder().encode(JSON.stringify(document));
  if (body.byteLength > limits.maxSnapshotBytes) {
    return {
      ok: false,
      code: "snapshot_too_large",
      totalBytes: body.byteLength,
    };
  }

  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < body.byteLength;
    offset += limits.snapshotChunkBytes
  ) {
    chunks.push(
      Buffer.from(
        body.subarray(offset, offset + limits.snapshotChunkBytes),
      ).toString("base64"),
    );
  }

  return {
    ok: true,
    totalBytes: body.byteLength,
    digest: createHash("sha256").update(body).digest("hex"),
    chunks,
  };
}
