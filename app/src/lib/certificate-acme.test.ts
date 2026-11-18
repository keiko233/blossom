import { describe, expect, it } from "vitest";

import {
  acmeChallengeFqdn,
  assertAuthorizedDnsChallenge,
  CertificateAcmeError,
  enforceAcmeJobFence,
  expectedDnsChallengeNames,
  sameDomainSet,
  sanitizeCertificateIssuanceError,
} from "./certificate-acme";

describe("certificate ACME fencing", () => {
  const now = new Date("2026-11-19T00:00:00.000Z");
  const fence = {
    jobId: "job-1",
    jobServerId: "srv-issuer",
    jobGeneration: 3,
    desiredGeneration: 3,
    challengeExpiresAt: new Date("2026-11-19T00:10:00.000Z"),
    now,
  };

  it("accepts only the exact issuer, generation, and live job", () => {
    expect(() => enforceAcmeJobFence(fence, "srv-issuer")).not.toThrow();

    expect(() => enforceAcmeJobFence(fence, "srv-other")).toThrow(
      expect.objectContaining<Partial<CertificateAcmeError>>({
        code: "issuer_mismatch",
      }),
    );
    expect(() =>
      enforceAcmeJobFence({ ...fence, jobGeneration: 2 }, "srv-issuer"),
    ).toThrow(
      expect.objectContaining<Partial<CertificateAcmeError>>({
        code: "stale_generation",
      }),
    );
    expect(() =>
      enforceAcmeJobFence(
        {
          ...fence,
          challengeExpiresAt: new Date("2026-11-18T23:59:59.000Z"),
        },
        "srv-issuer",
      ),
    ).toThrow(
      expect.objectContaining<Partial<CertificateAcmeError>>({
        code: "expired",
      }),
    );
  });

  it("derives bounded DNS challenge names for wildcard and apex domains", () => {
    expect(acmeChallengeFqdn("example.com")).toBe(
      "_acme-challenge.example.com",
    );
    expect(acmeChallengeFqdn("*.example.com")).toBe(
      "_acme-challenge.example.com",
    );
    expect([
      ...expectedDnsChallengeNames(["example.com", "*.example.com"]),
    ]).toEqual(["_acme-challenge.example.com"]);
    expect(() =>
      assertAuthorizedDnsChallenge(
        ["example.com"],
        "_acme-challenge.attacker.example",
      ),
    ).toThrow(
      expect.objectContaining<Partial<CertificateAcmeError>>({
        code: "invalid_challenge",
      }),
    );
  });

  it("compares certificate domain sets without order or case sensitivity", () => {
    expect(
      sameDomainSet(
        ["example.com", "*.example.com"],
        ["*.EXAMPLE.com", "example.com"],
      ),
    ).toBe(true);
    expect(
      sameDomainSet(["example.com"], ["example.com", "www.example.com"]),
    ).toBe(false);
  });

  it("strips PEM and credential-shaped text from errors", () => {
    const sanitized = sanitizeCertificateIssuanceError(
      "failed\n{{PRIVATE_KEY_rz5b4t3v}}\nsecret: abc\ntoken=xyz",
    );
    expect(sanitized).not.toContain("PRIVATE KEY");
    expect(sanitized).not.toContain("abc");
    expect(sanitized).not.toContain("xyz");
  });
});
