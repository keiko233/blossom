import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { encodeConfigSnapshot } from "./agent-ws-v2-snapshot";

const limits = { maxSnapshotBytes: 64, snapshotChunkBytes: 16 };

describe("encodeConfigSnapshot", () => {
  it("splits the exact JSON body into ordered chunks with its digest", () => {
    const document = { apiVersion: 3, desiredRevision: "7:sha256:abc" };
    const body = JSON.stringify(document);

    const encoded = encodeConfigSnapshot(document, limits);

    expect(encoded).toEqual({
      ok: true,
      totalBytes: Buffer.byteLength(body),
      digest: createHash("sha256").update(body).digest("hex"),
      chunks: expect.any(Array),
    });
    if (!encoded.ok) throw new Error("unreachable");
    expect(encoded.chunks).toHaveLength(
      Math.ceil(Buffer.byteLength(body) / 16),
    );
    expect(
      Buffer.concat(
        encoded.chunks.map((chunk) => Buffer.from(chunk, "base64")),
      ).toString("utf8"),
    ).toBe(body);
  });

  it("refuses a body over the aggregate limit instead of truncating it", () => {
    const encoded = encodeConfigSnapshot({ pad: "x".repeat(100) }, limits);

    expect(encoded).toEqual({
      ok: false,
      code: "snapshot_too_large",
      totalBytes: Buffer.byteLength(JSON.stringify({ pad: "x".repeat(100) })),
    });
  });

  it("counts multi-byte characters by their UTF-8 length", () => {
    const document = { name: "节点" };
    const encoded = encodeConfigSnapshot(document, {
      maxSnapshotBytes: 1024,
      snapshotChunkBytes: 1024,
    });
    expect(encoded).toMatchObject({
      ok: true,
      totalBytes: Buffer.byteLength(JSON.stringify(document)),
    });
  });
});
