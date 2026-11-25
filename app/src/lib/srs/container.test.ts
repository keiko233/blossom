import { describe, expect, test } from "vitest";

import {
  SRS_MAX_FILE_BYTES,
  SRS_MAX_PAYLOAD_BYTES,
  packSrs,
  unpackSrs,
} from "./container";
import { inspectSrs } from "./index";
import { decodePayload, encodePayload } from "./payload";

function payloadOf(source: Parameters<typeof encodePayload>[0]): Uint8Array {
  return encodePayload(source);
}

describe("container", () => {
  test("writes the SRS magic, version and zlib header", async () => {
    const bytes = await packSrs(payloadOf({ rules: [{ port: [443] }] }));
    expect([...bytes.subarray(0, 5)]).toEqual([0x53, 0x52, 0x53, 0x01, 0x78]);
  });

  test("round-trips a payload", async () => {
    const payload = payloadOf({
      rules: [
        { domain: ["example.com"], ip_cidr: ["192.0.2.0/24"] },
        { port: [80, 443], port_range: ["1000:2000"] },
      ],
    });
    const file = await packSrs(payload);
    const unpacked = await unpackSrs(file);
    expect(unpacked.version).toBe(1);
    expect([...unpacked.payload]).toEqual([...payload]);
    expect(decodePayload(unpacked.payload)).toEqual(decodePayload(payload));
  });

  test("accepts a custom supported version", async () => {
    const file = await packSrs(payloadOf({ rules: [{ port: [1] }] }), 5);
    expect((await unpackSrs(file)).version).toBe(5);
  });

  test("rejects wrong magic, versions and truncated zlib", async () => {
    const file = await packSrs(payloadOf({ rules: [{ port: [443] }] }));

    const magic = file.slice();
    magic[0] = 0x58;
    await expect(unpackSrs(magic)).rejects.toMatchObject({
      code: "invalid_magic",
    });

    for (const version of [0, 6]) {
      const badVersion = file.slice();
      badVersion[3] = version;
      await expect(unpackSrs(badVersion)).rejects.toMatchObject({
        code: "unsupported_version",
      });
    }

    await expect(
      unpackSrs(file.subarray(0, file.length - 3)),
    ).rejects.toMatchObject({ code: "inflate_failed" });
    await expect(
      unpackSrs(Uint8Array.of(0x53, 0x52, 0x53)),
    ).rejects.toMatchObject({ code: "truncated" });
  });

  test("rejects corrupted adler32 trailers", async () => {
    const file = await packSrs(
      payloadOf({ rules: [{ domain: ["example.com"] }] }),
    );
    const corrupt = file.slice();
    corrupt[corrupt.length - 1]! ^= 0xff;
    await expect(unpackSrs(corrupt)).rejects.toMatchObject({
      code: "inflate_failed",
    });
  });

  test("rejects files over the size bound", async () => {
    const oversized = new Uint8Array(SRS_MAX_FILE_BYTES + 1);
    oversized.set([0x53, 0x52, 0x53, 0x01]);
    await expect(unpackSrs(oversized)).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  test("stops an inflate bomb without returning the payload", async () => {
    const bombPayload = new Uint8Array(SRS_MAX_PAYLOAD_BYTES + 1);
    const file = await packSrs(bombPayload);
    expect(file.length).toBeLessThan(SRS_MAX_FILE_BYTES);
    await expect(unpackSrs(file)).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });

  test("inspects unsupported items as null stats", async () => {
    const withQueryType = await packSrs(Uint8Array.of(1, 0, 0, 1, 0, 1));
    await expect(inspectSrs(withQueryType)).resolves.toMatchObject({
      version: 1,
      stats: null,
    });
  });
});
