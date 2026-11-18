import { X509Certificate } from "node:crypto";

export interface DerCertificateInfo {
  raw: Buffer;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  dnsNames: string[];
  publicKeySpki: Buffer;
  certificate: X509Certificate;
}

export function parseDerCertificate(der: Buffer): DerCertificateInfo {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(der);
  } catch {
    throw new Error("Malformed certificate DER");
  }
  return {
    raw: Buffer.from(certificate.raw),
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    notBefore: new Date(certificate.validFrom),
    notAfter: new Date(certificate.validTo),
    dnsNames: parseDnsSubjectAltNames(certificate.subjectAltName),
    publicKeySpki: Buffer.from(
      certificate.publicKey.export({ type: "spki", format: "der" }),
    ),
    certificate,
  };
}

export async function verifyDerCertificateChain(
  chain: DerCertificateInfo[],
): Promise<void> {
  for (let index = 0; index < chain.length - 1; index++) {
    const subject = chain[index]!;
    const issuer = chain[index + 1]!;
    if (subject.issuer !== issuer.subject) {
      throw new Error(
        `Chain order broken at position ${index}: subject issuer does not match next certificate subject`,
      );
    }
    let valid = false;
    try {
      valid = subject.certificate.verify(issuer.certificate.publicKey);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error(
        `Chain signature verification failed at position ${index}`,
      );
    }
  }
}

function parseDnsSubjectAltNames(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4).toLowerCase());
}
