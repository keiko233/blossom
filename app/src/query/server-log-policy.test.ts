import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ServerLogPolicySourceView,
  ServerLogPolicyView,
} from "./log-policy";

const mocks = vi.hoisted(() => ({
  ensureAdmin: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  restore: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
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

vi.mock("@/lib/admin-audit-middleware", () => ({
  adminAudit: () => async (context: unknown) => context,
}));
vi.mock("@/lib/admin-audit", () => ({
  fromInput: () => () => undefined,
}));
vi.mock("@/lib/ensure-admin", () => ({
  ensureAdmin: mocks.ensureAdmin,
}));
vi.mock("@/lib/agent-notifications", () => ({
  notifyAgentLogPolicyChanged: mocks.notify,
}));
vi.mock("@/query/log-policy", async (importActual) => ({
  ...(await importActual<typeof import("./log-policy")>()),
  readServerLogPolicy: mocks.read,
  writeServerLogPolicy: mocks.write,
  restoreServerLogPolicy: mocks.restore,
}));

import {
  resetServerLogPolicy,
  updateServerLogPolicy,
} from "./server-log-policy";

const sourceView = (
  source: "agent" | "sing-box",
  level: "default" | "warn" | "debug",
): ServerLogPolicySourceView => ({
  source,
  present: true,
  desiredRevision: 2,
  desiredBaseline: level === "debug" ? "warn" : level,
  desiredLevel: level,
  desiredDeadline: null,
  expired: false,
  targetLevel: level,
  effectiveRevision: 1,
  effectiveLevel: "info",
  effectiveBaseline: "info",
  effectiveDeadline: null,
  effectiveError: null,
  effectivePending: false,
  effectiveAt: new Date("2026-11-19T00:00:00.000Z"),
  pending: true,
});

const policy = (): ServerLogPolicyView => ({
  serverId: "srv-1",
  revision: 2,
  sources: {
    agent: sourceView("agent", "warn"),
    "sing-box": sourceView("sing-box", "default"),
  },
});

beforeEach(() => {
  mocks.ensureAdmin.mockReset();
  mocks.read.mockReset().mockResolvedValue(policy());
  mocks.write.mockReset().mockResolvedValue({ revision: 2 });
  mocks.restore.mockReset().mockResolvedValue({ revision: 2 });
  mocks.notify.mockReset().mockResolvedValue(undefined);
});

describe("server log policy functions", () => {
  it("rejects a non-admin before reading or writing", async () => {
    mocks.ensureAdmin.mockRejectedValue(new Error("Forbidden"));
    await expect(
      updateServerLogPolicy({
        data: {
          serverId: "srv-1",
          source: "agent",
          level: "warn",
          expectedRevision: 1,
        },
      }),
    ).rejects.toThrow("Forbidden");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("returns a conflict without notifying when the revision moved", async () => {
    mocks.ensureAdmin.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.write.mockResolvedValue(null);
    mocks.read
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce({ ...policy(), revision: 3 });

    const result = await updateServerLogPolicy({
      data: {
        serverId: "srv-1",
        source: "agent",
        level: "warn",
        expectedRevision: 1,
      },
    });

    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("writes with the actor and pushes only after a successful compare-and-swap", async () => {
    mocks.ensureAdmin.mockResolvedValue({ user: { id: "admin-1" } });
    const result = await updateServerLogPolicy({
      data: {
        serverId: "srv-1",
        source: "agent",
        level: "warn",
        expectedRevision: 1,
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv-1",
        source: "agent",
        baseline: "warn",
        level: "warn",
        actorId: "admin-1",
        expectedRevision: 1,
      }),
    );
    expect(mocks.notify).toHaveBeenCalledWith("srv-1", 2, "agent");
  });

  it("restores the configured baseline for Restore now", async () => {
    mocks.ensureAdmin.mockResolvedValue({ user: { id: "admin-1" } });
    await resetServerLogPolicy({
      data: { serverId: "srv-1", source: "agent", expectedRevision: 1 },
    });
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv-1",
        source: "agent",
        mode: "restore-baseline",
        expectedRevision: 1,
      }),
    );
  });

  it("restores the installed default without clearing it implicitly", async () => {
    mocks.ensureAdmin.mockResolvedValue({ user: { id: "admin-1" } });
    await resetServerLogPolicy({
      data: {
        serverId: "srv-1",
        source: "agent",
        expectedRevision: 1,
        mode: "restore-default",
      },
    });
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "restore-default" }),
    );
  });

  it("keeps the configured baseline when applying a temporary override", async () => {
    mocks.ensureAdmin.mockResolvedValue({ user: { id: "admin-1" } });
    await updateServerLogPolicy({
      data: {
        serverId: "srv-1",
        source: "agent",
        level: "debug",
        temporarySeconds: 60,
        expectedRevision: 1,
      },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        baseline: "warn",
        level: "debug",
      }),
    );
  });

  it("rejects a temporary duration on a baseline level", async () => {
    mocks.ensureAdmin.mockResolvedValue({ user: { id: "admin-1" } });
    await expect(
      updateServerLogPolicy({
        data: {
          serverId: "srv-1",
          source: "agent",
          level: "warn",
          temporarySeconds: 300,
          expectedRevision: 1,
        },
      }),
    ).rejects.toThrow("only debug and trace accept a temporary duration");
  });
});
