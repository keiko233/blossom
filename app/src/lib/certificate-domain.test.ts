import { describe, expect, it } from "vitest";

import {
  certificateCoversDomain,
  isCertificateCurrentlyUsable,
  isValidCertificateDomain,
} from "./certificate-domain";

describe("isValidCertificateDomain", () => {
  it("accepts DNS names and single-label wildcards", () => {
    expect(isValidCertificateDomain("example.com")).toBe(true);
    expect(isValidCertificateDomain("*.example.com")).toBe(true);
  });

  it("rejects IP addresses and malformed wildcards", () => {
    expect(isValidCertificateDomain("192.0.2.1")).toBe(false);
    expect(isValidCertificateDomain("*.*.example.com")).toBe(false);
  });
});

describe("certificateCoversDomain", () => {
  it("matches exact names case-insensitively", () => {
    expect(certificateCoversDomain(["Example.COM"], "example.com")).toBe(true);
  });

  it("allows a wildcard for exactly one label", () => {
    expect(certificateCoversDomain(["*.example.com"], "edge.example.com")).toBe(
      true,
    );
    expect(certificateCoversDomain(["*.example.com"], "a.b.example.com")).toBe(
      false,
    );
    expect(certificateCoversDomain(["*.example.com"], "example.com")).toBe(
      false,
    );
  });
});

describe("isCertificateCurrentlyUsable", () => {
  const now = new Date("2026-07-18T00:00:00Z");
  const active = {
    activeMaterialVersion: 1,
    notBefore: new Date("2026-07-17T00:00:00Z"),
    notAfter: new Date("2026-10-17T00:00:00Z"),
  };

  it("accepts valid material without depending on server installation state", () => {
    expect(isCertificateCurrentlyUsable(active, true, now)).toBe(true);
  });

  it("rejects missing, future, and expired material", () => {
    expect(isCertificateCurrentlyUsable(active, false, now)).toBe(false);
    expect(
      isCertificateCurrentlyUsable(
        { ...active, notBefore: new Date("2026-07-19T00:00:00Z") },
        true,
        now,
      ),
    ).toBe(false);
    expect(
      isCertificateCurrentlyUsable({ ...active, notAfter: now }, true, now),
    ).toBe(false);
  });
});
