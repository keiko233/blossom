import { describe, expect, it, vi } from "vitest";

import {
  handleCertificateMaintenance,
  type CertificateMaintenanceDependencies,
} from "@/routes/api/maintenance/certificates";

const TOKEN = "test-maintenance-token";

function dependencies(
  overrides: Partial<CertificateMaintenanceDependencies> = {},
): CertificateMaintenanceDependencies {
  return {
    token: () => TOKEN,
    advance: vi.fn(async () => undefined),
    ...overrides,
  };
}

function request(authorization?: string) {
  return new Request("https://panel.example.com/api/maintenance/certificates", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("certificate maintenance", () => {
  it("is disabled when no token is configured", async () => {
    const deps = dependencies({ token: () => undefined });
    const response = await handleCertificateMaintenance(
      request(`Bearer ${TOKEN}`),
      deps,
    );
    expect(response.status).toBe(503);
    expect(deps.advance).not.toHaveBeenCalled();
  });

  it("requires the exact bearer token", async () => {
    const deps = dependencies();
    expect((await handleCertificateMaintenance(request(), deps)).status).toBe(
      401,
    );
    expect(
      (await handleCertificateMaintenance(request("Bearer wrong-token"), deps))
        .status,
    ).toBe(401);
    expect(deps.advance).not.toHaveBeenCalled();
  });

  it("advances issuance and returns an uncached summary", async () => {
    const deps = dependencies();
    const response = await handleCertificateMaintenance(
      request(`Bearer ${TOKEN}`),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ advanced: true });
    expect(deps.advance).toHaveBeenCalledTimes(1);
  });

  it("reports a failed sweep without leaking the error", async () => {
    const response = await handleCertificateMaintenance(
      request(`Bearer ${TOKEN}`),
      dependencies({
        advance: async () => {
          throw new Error("dns provider secret detail");
        },
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "certificate_sweep_failed",
    });
  });
});
