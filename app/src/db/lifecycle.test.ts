import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  request: undefined as Request | undefined,
  created: [] as string[],
  freshHyperdriveUrl: "postgresql://hyperdrive-fresh/test",
  cachedHyperdriveUrl: "postgresql://hyperdrive/test",
}));

vi.mock("@/lib/database-connection", () => ({
  getDatabaseRequest: () => state.request,
  getFreshHyperdriveConnectionString: () =>
    state.request ? state.freshHyperdriveUrl : undefined,
  getHyperdriveConnectionString: () =>
    state.request ? state.cachedHyperdriveUrl : undefined,
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ DATABASE_URL: "postgresql://localhost/test" }),
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: (connectionString: string) => {
    state.created.push(connectionString);
    const id = state.created.length;
    return {
      id,
      connectionString,
      select() {
        return this.id;
      },
    };
  },
}));
vi.mock("drizzle-orm/neon-http", () => ({ drizzle: vi.fn() }));

describe("database lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    state.request = undefined;
    state.created = [];
  });

  it("creates nothing during import and reuses the Node database", async () => {
    const { db } = await import("./index");
    expect(state.created).toHaveLength(0);
    expect(db.select()).toBe(1);
    expect(db.select()).toBe(1);
  });

  it("isolates Workers requests while sharing within one request", async () => {
    const { db, getDatabaseDriver } = await import("./index");
    const first = new Request("https://example.test/first");
    const second = new Request("https://example.test/second");
    state.request = first;
    expect(db.select()).toBe(1);
    expect(getDatabaseDriver()).toBe("node-postgres");
    state.request = second;
    expect(db.select()).toBe(2);
    state.request = first;
    expect(db.select()).toBe(1);
    expect(state.created).toHaveLength(2);
  });

  it("routes db to HYPERDRIVE_FRESH and dbCached to HYPERDRIVE", async () => {
    const { db, dbCached } = await import("./index");
    state.request = new Request("https://example.test/dual");
    expect(db.select()).toBe(1);
    expect(dbCached.select()).toBe(2);
    expect(state.created).toEqual([
      state.freshHyperdriveUrl,
      state.cachedHyperdriveUrl,
    ]);
  });
});
