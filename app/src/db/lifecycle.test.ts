import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  request: undefined as Request | undefined,
  created: 0,
}));

vi.mock("@/lib/database-connection", () => ({
  getDatabaseRequest: () => state.request,
  getHyperdriveConnectionString: () =>
    state.request ? "postgresql://hyperdrive/test" : undefined,
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ DATABASE_URL: "postgresql://localhost/test" }),
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => {
    const id = ++state.created;
    return {
      id,
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
    state.created = 0;
  });

  it("creates nothing during import and reuses the Node database", async () => {
    const { db } = await import("./index");
    expect(state.created).toBe(0);
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
    expect(state.created).toBe(2);
  });
});
