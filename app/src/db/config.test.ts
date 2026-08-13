import { describe, expect, it } from "vitest";

import { DatabaseDriver } from "@/lib/env-schema";

import { resolveDatabaseConfig } from "./config";

describe("resolveDatabaseConfig", () => {
  it("prefers Hyperdrive and uses the PostgreSQL wire driver", () => {
    expect(
      resolveDatabaseConfig({
        databaseUrl: "postgresql://direct.neon.tech/blossom",
        configuredDriver: DatabaseDriver.NeonHttp,
        hyperdriveConnectionString: "postgresql://hyperdrive/blossom",
      }),
    ).toEqual({
      connectionString: "postgresql://hyperdrive/blossom",
      driver: DatabaseDriver.NodePg,
    });
  });

  it("keeps the configured driver when Hyperdrive is unavailable", () => {
    expect(
      resolveDatabaseConfig({
        databaseUrl: "postgresql://database.example/blossom",
        configuredDriver: DatabaseDriver.NeonHttp,
      }).driver,
    ).toBe(DatabaseDriver.NeonHttp);
  });

  it("keeps the existing Neon URL auto-detection fallback", () => {
    expect(
      resolveDatabaseConfig({
        databaseUrl: "postgresql://example.neon.tech/blossom",
      }).driver,
    ).toBe(DatabaseDriver.NeonHttp);
  });
});
