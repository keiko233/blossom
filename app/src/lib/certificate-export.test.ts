import { describe, expect, it, vi } from "vitest";

import {
  certificateExportFilename,
  handleCertificateExport,
  type CertificateExportDependencies,
} from "./certificate-export";

function dependencies(
  overrides: Partial<CertificateExportDependencies> = {},
): CertificateExportDependencies {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { role: "admin" } }),
    getMaterial: vi.fn().mockResolvedValue({
      status: "ok",
      name: "Example Certificate",
      pem: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
    }),
    ...overrides,
  };
}

describe("handleCertificateExport", () => {
  it("requires an authenticated administrator", async () => {
    const unauthorized = await handleCertificateExport(
      "certificate-id",
      "fullchain",
      dependencies({ getSession: vi.fn().mockResolvedValue(null) }),
    );
    expect(unauthorized.status).toBe(401);

    const forbidden = await handleCertificateExport(
      "certificate-id",
      "fullchain",
      dependencies({
        getSession: vi.fn().mockResolvedValue({ user: { role: "user" } }),
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("rejects unsupported parts before looking up material", async () => {
    const deps = dependencies();
    const response = await handleCertificateExport(
      "certificate-id",
      "pending",
      deps,
    );
    expect(response.status).toBe(404);
    expect(deps.getMaterial).not.toHaveBeenCalled();
  });

  it("distinguishes missing certificates from missing active material", async () => {
    const missing = await handleCertificateExport(
      "certificate-id",
      "fullchain",
      dependencies({
        getMaterial: vi.fn().mockResolvedValue({ status: "not_found" }),
      }),
    );
    expect(missing.status).toBe(404);

    const pendingOnly = await handleCertificateExport(
      "certificate-id",
      "private-key",
      dependencies({
        getMaterial: vi
          .fn()
          .mockResolvedValue({ status: "no_active_material" }),
      }),
    );
    expect(pendingOnly.status).toBe(409);
  });

  it.each(["fullchain", "private-key"] as const)(
    "returns the current %s PEM with download safety headers",
    async (part) => {
      const response = await handleCertificateExport(
        "certificate-id",
        part,
        dependencies(),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="example-certificate-${part}.pem"`,
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toContain("BEGIN CERTIFICATE");
    },
  );
});

describe("certificateExportFilename", () => {
  it("removes unsafe characters and has a stable id fallback", () => {
    expect(
      certificateExportFilename('../../危险 "name"', "safe-id", "fullchain"),
    ).toBe("name-fullchain.pem");
    expect(certificateExportFilename("证书", "safe-id", "private-key")).toBe(
      "safe-id-private-key.pem",
    );
  });
});
