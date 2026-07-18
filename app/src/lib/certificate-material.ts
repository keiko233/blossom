import {
  SubjectAlternativeNameExtension,
  X509Certificate,
} from "@peculiar/x509";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  webcrypto,
} from "node:crypto";

import { isValidCertificateDomain } from "./certificate-domain";

export interface ParsedCertificateMaterial {
  certificatePem: string;
  privateKeyPem: string;
  domains: string[];
  notBefore: Date;
  notAfter: Date;
  fingerprintSha256: string;
}

const MAX_CHAIN_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 256 * 1024;

const ALLOWED_KEY_HEADERS = [
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
];
const REJECTED_KEY_HEADERS = [
  "ENCRYPTED PRIVATE KEY",
  "ENCRYPTED RSA PRIVATE KEY",
  "ENCRYPTED EC PRIVATE KEY",
  "PKCS12",
  "PFX",
  "CERTIFICATE",
];

interface PemBlock {
  label: string;
  body: string;
}

function parsePemBlocks(pem: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  const pattern =
    /-----BEGIN ([A-Z0-9\s]+)-----\r?\n?([A-Za-z0-9+/=\r\n\s]+?)-----END \1-----/g;
  let match: RegExpExecArray | null;
  let cursor = 0;
  while ((match = pattern.exec(pem)) !== null) {
    if (pem.slice(cursor, match.index).trim()) {
      throw new Error("Unexpected content outside PEM blocks");
    }
    const label = match[1].trim();
    const body = match[2].replace(/\s+/g, "");
    if (!body) {
      throw new Error(`Empty PEM block: ${label}`);
    }
    blocks.push({ label, body });
    cursor = pattern.lastIndex;
  }
  if (pem.slice(cursor).trim()) {
    throw new Error("Unexpected content outside PEM blocks");
  }
  return blocks;
}

function chainPem(certs: X509Certificate[]): string {
  return certs.map((cert) => cert.toString("pem")).join("");
}

function parseChain(chainPemValue: string): X509Certificate[] {
  if (Buffer.byteLength(chainPemValue, "utf8") > MAX_CHAIN_BYTES) {
    throw new Error("Certificate chain exceeds 1 MiB limit");
  }
  const blocks = parsePemBlocks(chainPemValue);
  const certs = blocks
    .filter((block) => block.label === "CERTIFICATE")
    .map((block) => {
      try {
        return new X509Certificate(Buffer.from(block.body, "base64"));
      } catch {
        throw new Error("Malformed certificate PEM block");
      }
    });
  if (certs.length === 0) {
    throw new Error("Certificate chain contains no certificates");
  }
  const nonCertBlocks = blocks.filter((block) => block.label !== "CERTIFICATE");
  if (nonCertBlocks.length > 0) {
    throw new Error(
      `Unexpected blocks in certificate chain: ${nonCertBlocks.map((block) => block.label).join(", ")}`,
    );
  }
  return certs;
}

function parsePrivateKey(privateKeyPemValue: string): {
  keyObject: KeyObject;
  normalizedPem: string;
} {
  if (Buffer.byteLength(privateKeyPemValue, "utf8") > MAX_KEY_BYTES) {
    throw new Error("Private key exceeds 256 KiB limit");
  }
  const blocks = parsePemBlocks(privateKeyPemValue);
  if (blocks.length !== 1) {
    throw new Error(
      `Expected exactly one private-key block, found ${blocks.length}`,
    );
  }
  const block = blocks[0]!;
  if (REJECTED_KEY_HEADERS.includes(block.label)) {
    throw new Error(
      `Unsupported or encrypted private-key format: ${block.label}`,
    );
  }
  if (!ALLOWED_KEY_HEADERS.includes(block.label)) {
    throw new Error(`Unsupported private-key format: ${block.label}`);
  }
  let keyObject: KeyObject;
  try {
    keyObject = createPrivateKey(privateKeyPemValue);
  } catch {
    throw new Error("Unable to parse private key");
  }
  if (keyObject.type !== "private") {
    throw new Error("Key object is not a private key");
  }
  const normalizedPem = keyObject.export({ type: "pkcs8", format: "pem" });
  if (typeof normalizedPem !== "string") {
    throw new Error("Private key normalization failed");
  }
  return { keyObject, normalizedPem };
}

function extractDnsNames(cert: X509Certificate): string[] {
  const names = new Set<string>();
  const sanExtension = cert.getExtension(SubjectAlternativeNameExtension);
  if (sanExtension) {
    for (const entry of sanExtension.names.items) {
      if (entry.type === "dns") {
        const value = entry.value.toLowerCase();
        if (!isValidCertificateDomain(value)) {
          throw new Error(`Leaf certificate has an invalid DNS SAN: ${value}`);
        }
        names.add(value);
      }
    }
  }
  return [...names];
}

function leafMatchesPrivateKey(
  leaf: X509Certificate,
  keyObject: KeyObject,
): boolean {
  const publicKeySpki = leaf.publicKey.rawData;
  const derivedPublicKey = createPublicKey(keyObject).export({
    type: "spki",
    format: "der",
  });
  return Buffer.from(publicKeySpki).equals(Buffer.from(derivedPublicKey));
}

async function verifyChainOrder(certs: X509Certificate[]): Promise<void> {
  for (let i = 0; i < certs.length - 1; i++) {
    const subject = certs[i]!;
    const issuer = certs[i + 1]!;
    if (subject.issuer !== issuer.subject) {
      throw new Error(
        `Chain order broken at position ${i}: subject issuer does not match next certificate subject`,
      );
    }
    let verified: boolean;
    try {
      verified = await subject.verify(
        { publicKey: issuer.publicKey },
        webcrypto as Crypto,
      );
    } catch {
      throw new Error(`Chain signature verification failed at position ${i}`);
    }
    if (!verified) {
      throw new Error(`Chain signature verification failed at position ${i}`);
    }
  }
}

export type ImportedValidity = "current" | "future" | "past";

export function classifyImportedValidity(
  material: Pick<ParsedCertificateMaterial, "notBefore" | "notAfter">,
  now = new Date(),
): ImportedValidity {
  if (now < material.notBefore) return "future";
  if (now >= material.notAfter) return "past";
  return "current";
}

/**
 * Parse and validate imported certificate material.
 *
 * Accepts a certificate full-chain PEM (leaf first, followed by intermediates)
 * plus an unencrypted private-key PEM in PKCS#8, PKCS#1 RSA, or SEC1 EC form.
 * Returns normalized PEMs and derived metadata. Does not reject certificates
 * based on their validity window.
 */
export async function parseCertificateMaterial(
  chainPemValue: string,
  privateKeyPemValue: string,
): Promise<ParsedCertificateMaterial> {
  const certs = parseChain(chainPemValue);
  const { keyObject, normalizedPem } = parsePrivateKey(privateKeyPemValue);

  await verifyChainOrder(certs);

  const leaf = certs[0]!;
  const domains = extractDnsNames(leaf);
  if (domains.length === 0) {
    throw new Error("Leaf certificate has no DNS subject alternative names");
  }

  if (!leafMatchesPrivateKey(leaf, keyObject)) {
    throw new Error("Private key does not match leaf certificate");
  }

  const normalizedChain = chainPem(certs);
  const fingerprintSha256 = createHash("sha256")
    .update(Buffer.from(leaf.rawData))
    .digest("hex");

  return {
    certificatePem: normalizedChain,
    privateKeyPem: normalizedPem,
    domains,
    notBefore: leaf.notBefore,
    notAfter: leaf.notAfter,
    fingerprintSha256,
  };
}
