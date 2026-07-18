import "reflect-metadata";
import {
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import {
  createHash,
  createPrivateKey,
  randomUUID,
  webcrypto,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  classifyImportedValidity,
  parseCertificateMaterial,
  type ParsedCertificateMaterial,
} from "./certificate-material";

async function generateKeyPair(
  algorithm: "RSA" | "ECDSA",
): Promise<CryptoKeyPair> {
  if (algorithm === "RSA") {
    return webcrypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
  }
  return webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

async function createSelfSigned(
  keyPair: CryptoKeyPair,
  domains: string[],
  notBefore: Date,
  notAfter: Date,
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: createHash("sha256").update(randomUUID()).digest("hex"),
      name: `CN=${domains[0]}`,
      notBefore,
      notAfter,
      signingAlgorithm:
        keyPair.privateKey.algorithm.name === "RSA"
          ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
          : { name: "ECDSA", hash: "SHA-256" },
      keys: keyPair,
      extensions: [
        new SubjectAlternativeNameExtension(
          domains.map((value) => ({ type: "dns" as const, value })),
        ),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      ],
    },
    webcrypto as Crypto,
  );
  const privateKey = await webcrypto.subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );
  return {
    certificatePem: certificate.toString("pem"),
    privateKeyPem: Buffer.from(privateKey)
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n"),
  };
}

async function createCa(): Promise<{
  keyPair: CryptoKeyPair;
  certificatePem: string;
}> {
  const keyPair = await generateKeyPair("ECDSA");
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 365 * 86_400_000);
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: toHex("ca"),
      name: "CN=Test CA",
      notBefore,
      notAfter,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      keys: keyPair,
      extensions: [
        new KeyUsagesExtension(
          KeyUsageFlags.digitalSignature | KeyUsageFlags.keyCertSign,
          true,
        ),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      ],
    },
    webcrypto as Crypto,
  );
  return {
    keyPair,
    certificatePem: certificate.toString("pem"),
  };
}

function toHex(value: string): string {
  return Buffer.from(value).toString("hex");
}

async function createLeafFromCa(
  ca: Awaited<ReturnType<typeof createCa>>,
  domains: string[],
  notBefore: Date,
  notAfter: Date,
  keyAlgorithm: "RSA" | "ECDSA" = "ECDSA",
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const leafKeyPair = await generateKeyPair(keyAlgorithm);
  const certificate = await X509CertificateGenerator.create(
    {
      serialNumber: toHex("leaf"),
      notBefore,
      notAfter,
      issuer: "CN=Test CA",
      subject: `CN=${domains[0]}`,
      publicKey: leafKeyPair.publicKey,
      signingKey: ca.keyPair.privateKey,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      extensions: [
        new SubjectAlternativeNameExtension(
          domains.map((value) => ({ type: "dns" as const, value })),
        ),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      ],
    },
    webcrypto as Crypto,
  );
  const privateKey = await webcrypto.subtle.exportKey(
    "pkcs8",
    leafKeyPair.privateKey,
  );
  return {
    certificatePem: certificate.toString("pem"),
    privateKeyPem: Buffer.from(privateKey)
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n"),
  };
}

function wrapPem(label: string, body: string): string {
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function convertPkcs8Body(body: string, type: "pkcs1" | "sec1"): string {
  const key = createPrivateKey({
    key: Buffer.from(body.replace(/\s+/g, ""), "base64"),
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
    const keyPair = await generateKeyPair("ECDSA");
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 86_400_000);
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["example.com", "*.example.com"],
      notBefore,
      notAfter,
    );
    const fullPrivateKey = wrapPem("PRIVATE KEY", privateKeyPem);
    const material = await parseCertificateMaterial(
      certificatePem,
      fullPrivateKey,
    );
    expect(material.domains).toEqual(["example.com", "*.example.com"]);
    expect(material.certificatePem).toBe(certificatePem);
    expect(material.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(material.privateKeyPem).toMatch(/-----END PRIVATE KEY-----\n$/);
    expect(material.fingerprintSha256).toBe(
      createHash("sha256")
        .update(Buffer.from(new X509Certificate(certificatePem).rawData))
        .digest("hex"),
    );
    expectCurrent(material);
  });

  it("accepts a current RSA leaf with PKCS#1 key", async () => {
    const keyPair = await generateKeyPair("RSA");
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 86_400_000);
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["rsa.example.com"],
      notBefore,
      notAfter,
    );
    const pkcs1Pem = convertPkcs8Body(privateKeyPem, "pkcs1");
    const material = await parseCertificateMaterial(certificatePem, pkcs1Pem);
    expect(material.domains).toEqual(["rsa.example.com"]);
    expect(material.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expectCurrent(material);
  });

  it("accepts an ECDSA SEC1 key and normalizes it to PKCS#8", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
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
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 86_400_000);
    const { certificatePem, privateKeyPem } = await createLeafFromCa(
      ca,
      ["chain.example.com"],
      notBefore,
      notAfter,
    );
    const fullchain = certificatePem + ca.certificatePem;
    const material = await parseCertificateMaterial(
      fullchain,
      wrapPem("PRIVATE KEY", privateKeyPem),
    );
    expect(material.domains).toEqual(["chain.example.com"]);
    expect(material.certificatePem).toBe(fullchain);
    expectCurrent(material);
  });

  it("accepts a future certificate without rejecting it", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const notBefore = new Date(Date.now() + 86_400_000);
    const notAfter = new Date(Date.now() + 172_800_000);
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["future.example.com"],
      notBefore,
      notAfter,
    );
    const material = await parseCertificateMaterial(
      certificatePem,
      wrapPem("PRIVATE KEY", privateKeyPem),
    );
    expectFuture(material);
  });

  it("accepts a past certificate without rejecting it", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const notBefore = new Date(Date.now() - 172_800_000);
    const notAfter = new Date(Date.now() - 86_400_000);
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["past.example.com"],
      notBefore,
      notAfter,
    );
    const material = await parseCertificateMaterial(
      certificatePem,
      wrapPem("PRIVATE KEY", privateKeyPem),
    );
    expectPast(material);
  });

  it("rejects a mismatched private key", async () => {
    const keyPair1 = await generateKeyPair("ECDSA");
    const keyPair2 = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keyPair1,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const { privateKeyPem } = await createSelfSigned(
      keyPair2,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem,
        wrapPem("PRIVATE KEY", privateKeyPem),
      ),
    ).rejects.toThrow("Private key does not match leaf certificate");
  });

  it("rejects a certificate with no DNS SAN", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const certificate = await X509CertificateGenerator.createSelfSigned(
      {
        serialNumber: toHex("no-san"),
        name: "CN=example.com",
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys: keyPair,
        extensions: [
          new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        ],
      },
      webcrypto as Crypto,
    );
    const privateKey = await webcrypto.subtle.exportKey(
      "pkcs8",
      keyPair.privateKey,
    );
    await expect(
      parseCertificateMaterial(
        certificate.toString("pem"),
        wrapPem(
          "PRIVATE KEY",
          Buffer.from(privateKey)
            .toString("base64")
            .match(/.{1,64}/g)!
            .join("\n"),
        ),
      ),
    ).rejects.toThrow("Leaf certificate has no DNS subject alternative names");
  });

  it("rejects an invalid DNS SAN", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["not a dns name"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem,
        wrapPem("PRIVATE KEY", privateKeyPem),
      ),
    ).rejects.toThrow("invalid DNS SAN");
  });

  it("rejects an encrypted private key", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const encryptedKey = `-----BEGIN ENCRYPTED PRIVATE KEY-----\nZmFrZQ==\n-----END ENCRYPTED PRIVATE KEY-----\n`;
    await expect(
      parseCertificateMaterial(certificatePem, encryptedKey),
    ).rejects.toThrow("Unsupported or encrypted private-key format");
  });

  it("rejects a PKCS12/PFX block", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const pfx = `-----BEGIN PKCS12-----\nZmFrZQ==\n-----END PKCS12-----\n`;
    await expect(parseCertificateMaterial(certificatePem, pfx)).rejects.toThrow(
      "Unsupported or encrypted private-key format",
    );
  });

  it("rejects extra key blocks", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const key = wrapPem("PRIVATE KEY", privateKeyPem);
    const doubleKey = key + key;
    await expect(
      parseCertificateMaterial(certificatePem, doubleKey),
    ).rejects.toThrow("Expected exactly one private-key block");
  });

  it("rejects a certificate block in the key input", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem,
        wrapPem("CERTIFICATE", Buffer.from(certificatePem).toString("base64")),
      ),
    ).rejects.toThrow("Unsupported or encrypted private-key format");
  });

  it("rejects an oversized chain", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const hugeChain = certificatePem.repeat(2000);
    await expect(
      parseCertificateMaterial(
        hugeChain,
        wrapPem("PRIVATE KEY", privateKeyPem),
      ),
    ).rejects.toThrow("Certificate chain exceeds 1 MiB limit");
  });

  it("rejects an oversized key", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    const hugeKey = wrapPem("PRIVATE KEY", "A".repeat(300_000));
    await expect(
      parseCertificateMaterial(certificatePem, hugeKey),
    ).rejects.toThrow("Private key exceeds 256 KiB limit");
  });

  it("rejects a broken chain order", async () => {
    const ca = await createCa();
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 86_400_000);
    const { certificatePem, privateKeyPem } = await createLeafFromCa(
      ca,
      ["chain.example.com"],
      notBefore,
      notAfter,
    );
    const reversedChain = ca.certificatePem + certificatePem;
    await expect(
      parseCertificateMaterial(
        reversedChain,
        wrapPem("PRIVATE KEY", privateKeyPem),
      ),
    ).rejects.toThrow("Chain order broken at position 0");
  });

  it("rejects a chain whose issuer name matches but signature does not", async () => {
    const signingCa = await createCa();
    const unrelatedCa = await createCa();
    const { certificatePem, privateKeyPem } = await createLeafFromCa(
      signingCa,
      ["chain.example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        certificatePem + unrelatedCa.certificatePem,
        wrapPem("PRIVATE KEY", privateKeyPem),
      ),
    ).rejects.toThrow("Chain signature verification failed");
  });

  it("rejects malformed PEM", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(certificatePem, "not a pem"),
    ).rejects.toThrow("Unexpected content outside PEM blocks");
  });

  it("rejects non-whitespace content outside PEM blocks", async () => {
    const keyPair = await generateKeyPair("ECDSA");
    const { certificatePem, privateKeyPem } = await createSelfSigned(
      keyPair,
      ["example.com"],
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
    );
    await expect(
      parseCertificateMaterial(
        `garbage\n${certificatePem}`,
        wrapPem("PRIVATE KEY", privateKeyPem),
      ),
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
