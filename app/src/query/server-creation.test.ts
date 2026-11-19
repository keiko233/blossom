import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (schema: { parse: (input: unknown) => unknown }) => {
        validate = (input) => schema.parse(input);
        return builder;
      },
      handler:
        (fn: (ctx: { data: unknown }) => unknown) =>
        (arg?: { data: unknown }) =>
          Promise.resolve().then(() => fn({ data: validate(arg?.data) })),
    };
    return builder;
  },
}));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        holder.inserted.push(values);
        return { returning: async () => [values] };
      },
    }),
  },
  getDatabaseDriver: () => "node-postgres",
}));
vi.mock("@/lib/admin-audit-middleware", () => ({ adminAudit: () => ({}) }));
vi.mock("@/lib/ensure-admin", () => ({
  ensureAdmin: async () => ({ user: { id: "admin", role: "admin" } }),
}));
vi.mock("@/lib/agent-notifications", () => ({
  notifyAgentConfigChanged: async () => undefined,
  notifyAgentUpdateTrigger: async () => undefined,
}));
vi.mock("@/query/agent", () => ({
  disableAgentBackupCredential: vi.fn(),
  enableAgentBackupCredential: vi.fn(),
  rotateAgentCredential: vi.fn(),
}));
vi.mock("@/query/config-change", () => ({
  countPendingConfigChangesByServer: async () => new Map(),
  recordConfigChange: vi.fn(),
}));
vi.mock("@/query/server-deletion", () => ({ deleteServerRecord: vi.fn() }));

import { createServer } from "./servers";

const base = { name: "edge", address: "edge.example.com" };

describe("server creation credentials", () => {
  beforeEach(() => {
    holder.inserted = [];
  });

  it("creates an OAuth-only server without a static token by default", async () => {
    const result = await createServer({ data: base });
    const inserted = holder.inserted[0]!;

    expect(result.token).toBeNull();
    expect(inserted.agentTokenHash).toBeNull();
    expect(inserted.agentTokenPrefix).toBeNull();
    expect("enableBackupToken" in inserted).toBe(false);
    expect(result.server.backupTokenEnabled).toBe(false);
    expect(Object.hasOwn(result.server, "agentTokenHash")).toBe(false);
  });

  it("creates a static backup only when explicitly requested", async () => {
    const result = await createServer({
      data: { ...base, enableBackupToken: true },
    });
    const inserted = holder.inserted[0]!;

    expect(result.token).toMatch(/^agt_/);
    expect(inserted.agentTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.agentTokenPrefix).toMatch(/^agt_/);
    expect(result.server.backupTokenEnabled).toBe(true);
    expect(Object.hasOwn(result.server, "agentTokenHash")).toBe(false);
  });
});
