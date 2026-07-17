import { describe, expect, it } from "vitest";

import {
  decryptCertificateSecret,
  encryptCertificateSecret,
} from "./certificate-crypto";

const KEY = Buffer.alloc(32, 7);

describe("certificate secret envelopes", () => {
  it("round trips while binding ciphertext to AAD", () => {
    const encrypted = encryptCertificateSecret(
      "private material",
      "cert:1",
      KEY,
    );
    expect(encrypted).not.toContain("private material");
    expect(decryptCertificateSecret(encrypted, "cert:1", KEY)).toBe(
      "private material",
    );
    expect(() => decryptCertificateSecret(encrypted, "cert:2", KEY)).toThrow();
  });

  it("rejects the wrong key and tampering", () => {
    const encrypted = encryptCertificateSecret(
      "private key",
      "certificate:1",
      KEY,
    );
    expect(() =>
      decryptCertificateSecret(encrypted, "certificate:1", Buffer.alloc(32, 8)),
    ).toThrow();
    expect(() =>
      decryptCertificateSecret(`${encrypted}x`, "certificate:1", KEY),
    ).toThrow();
  });
});
