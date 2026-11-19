import { describe, expect, it, vi } from "vitest";

import {
  handleServerMetricMaintenance,
  type ServerMetricMaintenanceDependencies,
} from "@/routes/api/maintenance/server-metrics";

const TOKEN = "test-maintenance-token";

function dependencies(
  overrides: Partial<ServerMetricMaintenanceDependencies> = {},
): ServerMetricMaintenanceDependencies {
  return {
    token: () => TOKEN,
    prune: vi.fn(async () => 7),
    ...overrides,
  };
}

function request(authorization?: string, query = "") {
  return new Request(
    `https://panel.example.com/api/maintenance/server-metrics${query}`,
    {
      method: "POST",
      headers: authorization ? { authorization } : {},
    },
  );
}

describe("server metric maintenance", () => {
  it("is disabled when no token is configured", async () => {
    const response = await handleServerMetricMaintenance(
      request(`Bearer ${TOKEN}`),
      dependencies({ token: () => undefined }),
    );
    expect(response.status).toBe(503);
  });

  it("requires the exact bearer token", async () => {
    const deps = dependencies();
    expect((await handleServerMetricMaintenance(request(), deps)).status).toBe(
      401,
    );
    expect(
      (
        await handleServerMetricMaintenance(
          request("Bearer wrong-maintenance-token"),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(deps.prune).not.toHaveBeenCalled();
  });

  it("clamps the bounded work and keeps the cutoff in the store", async () => {
    const deps = dependencies();
    const response = await handleServerMetricMaintenance(
      request(`Bearer ${TOKEN}`, "?batchSize=999999&maxBatches=0"),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: 7,
      batchSize: 5000,
      maxBatches: 10,
    });
    expect(deps.prune).toHaveBeenCalledWith({
      now: expect.any(Number),
      batchSize: 5000,
      maxBatches: 10,
    });
  });
});
