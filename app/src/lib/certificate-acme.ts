import { isValidCertificateDomain } from "@blossom/domain/certificate-domain";

export type CertificateAcmeErrorCode =
  | "issuer_mismatch"
  | "expired"
  | "stale_generation"
  | "invalid_challenge"
  | "not_found";

export class CertificateAcmeError extends Error {
  constructor(
    readonly code: CertificateAcmeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CertificateAcmeError";
  }
}

export interface AcmeJobFence {
  jobId: string;
  jobServerId: string;
  jobGeneration: number;
  desiredGeneration: number;
  challengeExpiresAt: Date;
  now?: Date;
}

export function enforceAcmeJobFence(
  input: AcmeJobFence,
  authenticatedServerId: string,
): void {
  if (input.jobServerId !== authenticatedServerId) {
    throw new CertificateAcmeError(
      "issuer_mismatch",
      "ACME job belongs to a different issuer server",
    );
  }
  if (input.jobGeneration !== input.desiredGeneration) {
    throw new CertificateAcmeError(
      "stale_generation",
      "ACME job targets a superseded certificate generation",
    );
  }
  if ((input.now ?? new Date()) >= input.challengeExpiresAt) {
    throw new CertificateAcmeError("expired", "ACME job has expired");
  }
}

export function acmeChallengeFqdn(domain: string): string {
  const normalized = domain.toLowerCase();
  if (!isValidCertificateDomain(normalized)) {
    throw new CertificateAcmeError(
      "invalid_challenge",
      "Certificate policy contains an invalid DNS name",
    );
  }
  const base = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  const fqdn = `_acme-challenge.${base}`;
  if (fqdn.length > 253) {
    throw new CertificateAcmeError(
      "invalid_challenge",
      "DNS-01 challenge name exceeds the DNS limit",
    );
  }
  return fqdn;
}

export function expectedDnsChallengeNames(
  domains: readonly string[],
): Set<string> {
  return new Set(domains.map(acmeChallengeFqdn));
}

export function assertAuthorizedDnsChallenge(
  domains: readonly string[],
  fqdn: string,
): void {
  const expected = expectedDnsChallengeNames(domains);
  if (!expected.has(fqdn.toLowerCase())) {
    throw new CertificateAcmeError(
      "invalid_challenge",
      "DNS-01 record is outside the certificate policy domains",
    );
  }
}

export function sameDomainSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const expected = new Set(left.map((domain) => domain.toLowerCase()));
  return right.every((domain) => expected.has(domain.toLowerCase()));
}

export function isAcmeCapableAgent(capabilities: readonly string[]): boolean {
  return capabilities.includes("acme-v1");
}

/** Keeps CA/agent errors out of logs and UI without truncating a PEM body in. */
export function sanitizeCertificateIssuanceError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines: string[] = [];
  let inPem = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.includes("-----BEGIN ")) {
      inPem = true;
      continue;
    }
    if (inPem) {
      if (line.includes("-----END ")) {
        inPem = false;
      }
      continue;
    }
    lines.push(
      [...line]
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code === 9 || (code >= 32 && code !== 127);
        })
        .join(""),
    );
  }
  return lines
    .join("\n")
    .replace(
      /(authorization|token|secret|private[_ -]?key)\s*[:=]\s*\S+/gi,
      "$1=<redacted>",
    )
    .trim()
    .slice(0, 4096);
}
