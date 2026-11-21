import { describe, expect, it } from "vitest";

import {
  decryptManagedPeerCredential,
  encryptManagedPeerCredential,
  managedPeerCredentialAad,
} from "./managed-credential-crypto";

const KEY = Buffer.alloc(32, 9);

describe("managed peer credential envelopes", () => {
  it("binds ciphertext to the exact link and generation context", () => {
    const ciphertext = encryptManagedPeerCredential(
      "link-a-to-b",
      3,
      "peer-secret",
      KEY,
    );
    expect(managedPeerCredentialAad("link-a-to-b", 3)).toBe(
      "managed-peer-credential:link-a-to-b:3",
    );
    expect(ciphertext).not.toContain("peer-secret");
    expect(
      decryptManagedPeerCredential(ciphertext, "link-a-to-b", 3, KEY),
    ).toBe("peer-secret");
    expect(() =>
      decryptManagedPeerCredential(ciphertext, "link-a-to-c", 3, KEY),
    ).toThrow();
    expect(() =>
      decryptManagedPeerCredential(ciphertext, "link-a-to-b", 4, KEY),
    ).toThrow();
  });
});
