import { createHash, randomBytes, webcrypto } from "node:crypto";

import {
  dnsExtensions,
  ecdsaSignatureToDer,
  encodeCertificate,
  encodeTbsCertificate,
  OID_ECDSA_SHA256,
  subjectName,
  toPem,
} from "./x509-der";

export interface SelfSignedMaterial {
  certificatePem: string;
  privateKeyPem: string;
  notBefore: Date;
  notAfter: Date;
  fingerprintSha256: string;
}

export async function createSelfSignedCertificate(input: {
  domains: string[];
  validityDays: number;
  now?: Date;
}): Promise<SelfSignedMaterial> {
  if (input.domains.length === 0 || input.domains.length > 100) {
    throw new Error("Self-signed certificate domain count is invalid");
  }
  if (!Number.isInteger(input.validityDays) || input.validityDays < 1) {
    throw new Error("Self-signed certificate validity is invalid");
  }
  const now = input.now ?? new Date();
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(
    notBefore.getTime() + input.validityDays * 86_400_000,
  );
  const keys = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = Buffer.from(
    await webcrypto.subtle.exportKey("spki", keys.publicKey),
  );
  const pkcs8 = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
  );

  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f || 1;
  const name = subjectName(input.domains[0]!);
  const tbs = encodeTbsCertificate({
    serial,
    issuer: name,
    subject: name,
    notBefore,
    notAfter,
    spki,
    extensions: dnsExtensions(input.domains),
    signatureAlgorithmOid: OID_ECDSA_SHA256,
  });
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new Uint8Array(tbs),
  );
  const certificateDer = encodeCertificate(
    tbs,
    OID_ECDSA_SHA256,
    ecdsaSignatureToDer(Buffer.from(signature)),
  );
  return {
    certificatePem: toPem("CERTIFICATE", certificateDer),
    privateKeyPem: toPem("PRIVATE KEY", pkcs8),
    notBefore,
    notAfter,
    fingerprintSha256: createHash("sha256")
      .update(certificateDer)
      .digest("hex"),
  };
}
