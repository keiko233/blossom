import { describe, expect, it } from "vitest";

import {
  certificateActionFor,
  type CertificateActionContext,
} from "./certificate-actions";

function context(overrides?: {
  activeGeneration?: number | null;
  appliedGeneration?: number | null;
  material?: CertificateActionContext["material"];
}): CertificateActionContext {
  const activeGeneration =
    overrides && "activeGeneration" in overrides
      ? overrides.activeGeneration
      : 3;
  const appliedGeneration =
    overrides && "appliedGeneration" in overrides
      ? overrides.appliedGeneration
      : 3;
  return {
    certificate: {
      id: "cert-1",
      domains: ["example.com"],
      activeMaterialVersion: activeGeneration ?? null,
    },
    binding: {
      enabled: true,
      desiredGeneration: 3,
      appliedGeneration: appliedGeneration ?? null,
    },
    material:
      overrides && "material" in overrides
        ? overrides.material
        : {
            certificatePem: "certificate",
            privateKeyPem: "private-key",
            notBefore: "2026-01-01T00:00:00.000Z",
            notAfter: "2027-01-01T00:00:00.000Z",
            fingerprintSha256: "fingerprint",
          },
  };
}

describe("certificateActionFor", () => {
  it("keeps sending desired material after the generation was acknowledged", () => {
    expect(certificateActionFor(context(), "server-1")).toMatchObject({
      id: "certificate:cert-1:server-1:3:install",
      type: "certificate.install",
      generation: 3,
      reportRequired: false,
      material: {
        certificatePem: "certificate",
        privateKeyPem: "private-key",
      },
    });
  });

  it("requires an acknowledgement while the applied generation is stale", () => {
    expect(
      certificateActionFor(context({ appliedGeneration: 2 }), "server-1"),
    ).toMatchObject({
      type: "certificate.install",
      reportRequired: true,
    });
  });

  it("does not emit an install without active material", () => {
    expect(
      certificateActionFor(context({ material: undefined }), "server-1"),
    ).toBeNull();
  });
});
