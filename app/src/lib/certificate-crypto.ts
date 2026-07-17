import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getServerEnv } from "./env";

const PREFIX = "v1";

function decodeKey(value: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(value, "base64url");
  } catch {
    throw new Error("CERTIFICATE_MASTER_KEY must be base64url encoded");
  }
  if (key.length !== 32) {
    throw new Error("CERTIFICATE_MASTER_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function certificateMasterKey(): Buffer {
  const value = getServerEnv().CERTIFICATE_MASTER_KEY;
  if (!value) {
    throw new Error(
      "Certificate management requires CERTIFICATE_MASTER_KEY (32 random bytes, base64url encoded)",
    );
  }
  return decodeKey(value);
}

/** AES-256-GCM envelope. The caller-provided AAD binds a secret to its row/version. */
export function encryptCertificateSecret(
  plaintext: string,
  aad: string,
  key = certificateMasterKey(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptCertificateSecret(
  envelope: string,
  aad: string,
  key = certificateMasterKey(),
): string {
  const [prefix, iv, tag, ciphertext, extra] = envelope.split(":");
  if (prefix !== PREFIX || !iv || !tag || ciphertext === undefined || extra) {
    throw new Error("Invalid encrypted certificate secret");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt certificate secret");
  }
}
