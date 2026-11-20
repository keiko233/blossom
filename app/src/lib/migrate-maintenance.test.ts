import { describe, expect, it, vi } from "vitest";

import {
  handleMigrateMaintenance,
  type MigrateMaintenanceDependencies,
} from "@/routes/api/maintenance/migrate";

const TOKEN = "test-maintenance-token";

function dependencies(
  overrides: Partial<MigrateMaintenanceDependencies> = {},
): MigrateMaintenanceDependencies {
  return {
    token: () => TOKEN,
    migrate: vi.fn(async () => ({
      total: 33,
      applied: ["20261120000000_example"],
      skipped: 32,
    })),
    ...overrides,
  };
}

function request(authorization?: string) {
  return new Request("https://panel.example.com/api/maintenance/migrate", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("migrate maintenance endpoint", () => {
  it("is disabled when MAINTENANCE_TOKEN is unset", async () => {
    const deps = dependencies({ token: () => undefined });
    const response = await handleMigrateMaintenance(
      request(`Bearer ${TOKEN}`),
      deps,
    );
    expect(response.status).toBe(503);
    expect(deps.migrate).not.toHaveBeenCalled();
  });

  it("requires the exact bearer token", async () => {
    const deps = dependencies();
    expect((await handleMigrateMaintenance(request(), deps)).status).toBe(401);
    expect(
      (
        await handleMigrateMaintenance(
          request("Bearer wrong-maintenance-token"),
          deps,
        )
      ).status,
    ).toBe(401);
    expect(deps.migrate).not.toHaveBeenCalled();
  });

  it("runs bundled migrations and returns the summary", async () => {
    const deps = dependencies();
    const response = await handleMigrateMaintenance(
      request(`Bearer ${TOKEN}`),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      total: 33,
      applied: ["20261120000000_example"],
      skipped: 32,
    });
    expect(deps.migrate).toHaveBeenCalledTimes(1);
  });

  it("returns 500 without leaking error details when migration fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = dependencies({
      migrate: vi.fn(async () => {
        throw new Error("postgresql://secret@host/db connection failed");
      }),
    });

    const response = await handleMigrateMaintenance(
      request(`Bearer ${TOKEN}`),
      deps,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "migration_failed" });
    errorSpy.mockRestore();
  });
});
