import { describe, expect, it, vi } from "vitest";

import {
  handleManagedRolloutMaintenance,
  type ManagedRolloutMaintenanceDependencies,
} from "@/routes/api/maintenance/managed-rollouts";

const TOKEN = "test-maintenance-token";

function dependencies(
  overrides: Partial<ManagedRolloutMaintenanceDependencies> = {},
): ManagedRolloutMaintenanceDependencies {
  return {
    token: () => TOKEN,
    sweep: vi.fn(async () => ({
      activationDisabled: false,
      scanned: 3,
      followUps: [],
      errors: 0,
    })),
    dispatch: vi.fn(async () => ({
      notifiedServerIds: ["srv-a"],
      probeIds: ["probe-1"],
    })),
    ...overrides,
  };
}

function request(authorization?: string, query = "") {
  return new Request(
    `https://panel.example.com/api/maintenance/managed-rollouts${query}`,
    {
      method: "POST",
      headers: authorization ? { authorization } : {},
    },
  );
}

describe("managed rollout maintenance", () => {
  it("is disabled when no token is configured", async () => {
    const response = await handleManagedRolloutMaintenance(
      request(`Bearer ${TOKEN}`),
      dependencies({ token: () => undefined }),
    );
    expect(response.status).toBe(503);
  });

  it("requires the exact bearer token before sweeping", async () => {
    const deps = dependencies();
    expect(
      (await handleManagedRolloutMaintenance(request(), deps)).status,
    ).toBe(401);
    expect(
      (
        await handleManagedRolloutMaintenance(
          request("Bearer wrong-maintenance-token"),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(deps.sweep).not.toHaveBeenCalled();
  });

  it("clamps the bounded limit and reports delivery counts only", async () => {
    const deps = dependencies();
    const response = await handleManagedRolloutMaintenance(
      request(`Bearer ${TOKEN}`, "?limit=999999"),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activationDisabled: false,
      scanned: 3,
      errors: 0,
      notified: 1,
      probes: 1,
      limit: 50,
    });
    expect(deps.sweep).toHaveBeenCalledWith({
      limit: 50,
      now: expect.any(Date),
    });
  });

  it("still authenticates and reports activation disabled without sweeping", async () => {
    const deps = dependencies({
      sweep: vi.fn(async () => ({
        activationDisabled: true,
        scanned: 0,
        followUps: [],
        errors: 0,
      })),
    });
    const response = await handleManagedRolloutMaintenance(
      request(`Bearer ${TOKEN}`, "?limit=0"),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activationDisabled: true,
      scanned: 0,
      errors: 0,
      notified: 0,
      probes: 0,
      limit: 10,
    });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
