import { createPrivateKey, randomBytes, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  classifyImportedValidity,
  parseCertificateMaterial,
  type ParsedCertificateMaterial,
} from "./certificate-material";
import {
  caExtensions,
  dnsExtensions,
  ecdsaSignatureToDer,
  encodeCertificate,
  encodeTbsCertificate,
  OID_ECDSA_SHA256,
  OID_RSA_SHA256,
  subjectName,
  toPem,
} from "./x509-der";

interface KeyPair {
  algorithm: "RSA" | "ECDSA";
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

async function generateKeyPair(algorithm: "RSA" | "ECDSA"): Promise<KeyPair> {
  if (algorithm === "RSA") {
    const keys = (await webcrypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return { algorithm, ...keys };
  }
  const keys = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { algorithm, ...keys };
}

async function exportKey(keys: KeyPair): Promise<string> {
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return toPem("PRIVATE KEY", Buffer.from(pkcs8));
}

async function sign(
  keys: KeyPair,
  algorithmOid: Buffer,
  data: Buffer,
): Promise<Buffer> {
  if (algorithmOid.equals(OID_RSA_SHA256)) {
    return Buffer.from(
      await webcrypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        keys.privateKey,
        new Uint8Array(data),
      ),
    );
  }
  return ecdsaSignatureToDer(
    Buffer.from(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new Uint8Array(data),
      ),
    ),
  );
}

async function createSelfSigned(
  keys: KeyPair,
  domains: string[],
  notBefore: Date,
  notAfter: Date,
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const algorithmOid =
    keys.algorithm === "RSA" ? OID_RSA_SHA256 : OID_ECDSA_SHA256;
  const spki = Buffer.from(
    await webcrypto.subtle.exportKey("spki", keys.publicKey),
  );
  const name = subjectName(domains[0]!);
  const tbs = encodeTbsCertificate({
    serial: randomBytes(8),
    issuer: name,
    subject: name,
    notBefore,
    notAfter,
    spki,
    extensions: dnsExtensions(domains),
    signatureAlgorithmOid: algorithmOid,
  });
  const certificate = encodeCertificate(
    tbs,
    algorithmOid,
    await sign(keys, algorithmOid, tbs),
  );
  return {
    certificatePem: toPem("CERTIFICATE", certificate),
    privateKeyPem: await exportKey(keys),
  };
}

async function createCa(): Promise<{
  keys: KeyPair;
  certificatePem: string;
}> {
  const keys = await generateKeyPair("ECDSA");
  const name = subjectName("Blossom Test CA");
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 365 * 86_400_000);
  const tbs = encodeTbsCertificate({
    serial: randomBytes(8),
    issuer: name,
    subject: name,
    notBefore,
    notAfter,
    spki: Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)),
    extensions: caExtensions(),
    signatureAlgorithmOid: OID_ECDSA_SHA256,
  });
  return {
    keys,
    certificatePem: toPem(
      "CERTIFICATE",
      encodeCertificate(
        tbs,
        OID_ECDSA_SHA256,
        await sign(keys, OID_ECDSA_SHA256, tbs),
      ),
    ),
  };
}

async function createLeafFromCa(
  ca: Awaited<ReturnType<typeof createCa>>,
  domains: string[],
  notBefore: Date,
  notAfter: Date,
  keyAlgorithm: "RSA" | "ECDSA" = "ECDSA",
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const keys = await generateKeyPair(keyAlgorithm);
  const algorithmOid =
    keys.algorithm === "RSA" ? OID_RSA_SHA256 : OID_ECDSA_SHA256;
  const tbs = encodeTbsCertificate({
    serial: randomBytes(8),
    issuer: subjectName("Blossom Test CA"),
    subject: subjectName(domains[0]!),
    notBefore,
    notAfter,
    spki: Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)),
    extensions: dnsExtensions(domains),
    signatureAlgorithmOid: algorithmOid,
  });
  return {
    certificatePem: toPem(
      "CERTIFICATE",
      encodeCertificate(
        tbs,
        algorithmOid,
        await sign(ca.keys, algorithmOid, tbs),
      ),
    ),
    privateKeyPem: await exportKey(keys),
  };
}

function wrapPem(label: string, body: string): string {
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function convertPkcs8Body(body: string, type: "pkcs1" | "sec1"): string {
  const base64 = body
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const key = createPrivateKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return key.export({ format: "pem", type }).toString();
}

function expectCurrent(material: ParsedCertificateMaterial): void {
  expect(classifyImportedValidity(material)).toBe("current");
}

function expectFuture(material: ParsedCertificateMaterial): void {
  expect(classifyImportedValidity(material)).toBe("future");
}

function expectPast(material: ParsedCertificateMaterial): void {
  expect(classifyImportedValidity(material)).toBe("past");
}

describe("parseCertificateMaterial", () => {
  it("accepts a current ECDSA leaf and normalizes the key to PKCS#8", async () => {
    const keys = await generateKeyPair("ECDSA");
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 86_400_000);
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["example.com", "*.example.com"],
      notBefore,
      notAfter,
    );
    const material = await parseCertificateMaterial(
      certificatePem,
      privateKeyPem,
    );
    expect(material.domains).toEqual(["example.com", "*.example.com"]);
    expect(material.certificatePem).toBe(certificatePem);
    expect(material.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expectCurrent(material);
  });

  it("accepts a current RSA leaf with PKCS#1 key", async () => {
    const keys = await generateKeyPair("RSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["rsa.example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const pkcs1Pem = convertPkcs8Body(privateKeyPem, "pkcs1");
    const material = await parseCertificateMaterial(certificatePem, pkcs1Pem);
    expect(material.domains).toEqual(["rsa.example.com"]);
    expect(material.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expectCurrent(material);
  });

  it("accepts an ECDSA SEC1 key and normalizes it to PKCS#8", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["ecdsa.example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const material = await parseCertificateMaterial(
      certificatePem,
      convertPkcs8Body(privateKeyPem, "sec1"),
    );
    expect(material.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("accepts a multi-certificate chain and verifies signatures", async () => {
    const ca = await createCa();
    const { certificatePem, privateKeyPem } = await createLeafFromCa(
      ca,
      ["chain.example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const material = await parseCertificateMaterial(
      certificatePem + ca.certificatePem,
      privateKeyPem,
    );
    expect(material.domains).toEqual(["chain.example.com"]);
    expect(material.certificatePem).toBe(certificatePem + ca.certificatePem);
    expectCurrent(material);
  });

  it("accepts a future certificate without rejecting it", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["future.example.com"],
      new Date(Date.now() + 86_400_000),
      new Date(Date.now() + 172_800_000),
    );
    expectFuture(await parseCertificateMaterial(certificatePem, privateKeyPem));
  });

  it("accepts a past certificate without rejecting it", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["past.example.com"],
      new Date(Date.now() - 172_800_000),
      new Date(Date.now() - 86_400_000),
    );
    expectPast(await parseCertificateMaterial(certificatePem, privateKeyPem));
  });

  it("rejects a mismatched private key", async () => {
    const first = await createSelfSigned(
      await generateKeyPair("ECDSA"),
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const second = await createSelfSigned(
      await generateKeyPair("ECDSA"),
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(first.certificatePem, second.privateKeyPem),
    ).rejects.toThrow("Private key does not match leaf certificate");
  });

  it("rejects a certificate with no DNS SAN", async () => {
    const keys = await generateKeyPair("ECDSA");
    const name = subjectName("example.com");
    const tbs = encodeTbsCertificate({
      serial: randomBytes(8),
      issuer: name,
      subject: name,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      spki: Buffer.from(
        await webcrypto.subtle.exportKey("spki", keys.publicKey),
      ),
      extensions: [],
      signatureAlgorithmOid: OID_ECDSA_SHA256,
    });
    const certificatePem = toPem(
      "CERTIFICATE",
      encodeCertificate(
        tbs,
        OID_ECDSA_SHA256,
        await sign(keys, OID_ECDSA_SHA256, tbs),
      ),
    );
    await expect(
      parseCertificateMaterial(certificatePem, await exportKey(keys)),
    ).rejects.toThrow("Leaf certificate has no DNS subject alternative names");
  });

  it("rejects a broken chain order", async () => {
    const ca = await createCa();
    const leaf = await createLeafFromCa(
      ca,
      ["chain.example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        ca.certificatePem + leaf.certificatePem,
        leaf.privateKeyPem,
      ),
    ).rejects.toThrow("Chain order broken at position 0");
  });

  it("rejects a chain whose issuer name matches but signature does not", async () => {
    const signingCa = await createCa();
    const unrelatedCa = await createCa();
    const leaf = await createLeafFromCa(
      signingCa,
      ["chain.example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        leaf.certificatePem + unrelatedCa.certificatePem,
        leaf.privateKeyPem,
      ),
    ).rejects.toThrow("Chain signature verification failed");
  });

  it("rejects malformed PEM", async () => {
    await expect(
      parseCertificateMaterial("not a pem", "not a pem"),
    ).rejects.toThrow("Unexpected content outside PEM blocks");
  });

  it("rejects encrypted keys", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem,
        wrapPem("ENCRYPTED PRIVATE KEY", "ZmFrZQ=="),
      ),
    ).rejects.toThrow("Unsupported or encrypted private-key format");
  });

  it("rejects a PKCS12/PFX block", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(certificatePem, wrapPem("PKCS12", "ZmFrZQ==")),
    ).rejects.toThrow("Unsupported or encrypted private-key format");
  });

  it("rejects extra key blocks", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(certificatePem, privateKeyPem + privateKeyPem),
    ).rejects.toThrow("Expected exactly one private-key block");
  });

  it("rejects a certificate block in the key input", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem,
        wrapPem("CERTIFICATE", "ZmFrZQ=="),
      ),
    ).rejects.toThrow("Unsupported or encrypted private-key format");
  });

  it("rejects an oversized chain", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(certificatePem.repeat(2000), privateKeyPem),
    ).rejects.toThrow("Certificate chain exceeds 1 MiB limit");
  });

  it("rejects an oversized key", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem,
        wrapPem("PRIVATE KEY", "A".repeat(300_000)),
      ),
    ).rejects.toThrow("Private key exceeds 256 KiB limit");
  });

  it("rejects non-whitespace content outside PEM blocks", async () => {
    const keys = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keys,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(`garbage\n${certificatePem}`, privateKeyPem),
    ).rejects.toThrow("Unexpected content outside PEM blocks");
  });
});

describe("classifyImportedValidity", () => {
  it("classifies current, future, and past windows", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    expect(
      classifyImportedValidity(
        {
          notBefore: new Date("2024-12-31T00:00:00Z"),
          notAfter: new Date("2025-01-02T00:00:00Z"),
        },
        now,
      ),
    ).toBe("current");
    expect(
      classifyImportedValidity(
        {
          notBefore: new Date("2025-01-02T00:00:00Z"),
          notAfter: new Date("2025-01-03T00:00:00Z"),
        },
        now,
      ),
    ).toBe("future");
    expect(
      classifyImportedValidity(
        {
          notBefore: new Date("2024-12-29T00:00:00Z"),
          notAfter: new Date("2024-12-31T00:00:00Z"),
        },
        now,
      ),
    ).toBe("past");
  });
});
