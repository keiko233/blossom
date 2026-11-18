import { createPrivateKey, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createSelfSignedCertificate } from "./self-signed-certificate";

describe("createSelfSignedCertificate", () => {
  it("creates a P-256 certificate with DNS SANs and a matching key", async () => {
    const material = await createSelfSignedCertificate({
      domains: ["example.com", "*.example.com"],
      validityDays: 30,
      now: new Date("2026-11-19T00:00:00.000Z"),
    });
    const certificate = new X509Certificate(material.certificatePem);
    expect(certificate.subjectAltName).toBe(
      "DNS:example.com, DNS:*.example.com",
    );
    expect(
      certificate.checkPrivateKey(createPrivateKey(material.privateKeyPem)),
    ).toBe(true);
    expect(certificate.fingerprint256).toBe(
      material.fingerprintSha256.toUpperCase().match(/.{2}/g)!.join(":"),
    );
    expect(material.notBefore.toISOString()).toBe("2026-11-18T23:55:00.000Z");
  });
});
