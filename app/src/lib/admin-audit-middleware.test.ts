import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NewAdminAuditLog } from "@/db/admin-audit-schema";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(),
  appendAdminAudit: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: mocks.getRequest,
}));
vi.mock("@/lib/ensure-admin", () => ({
  getAdminSession: mocks.getAdminSession,
}));
vi.mock("@/query/admin-audit-record", () => ({
  appendAdminAudit: mocks.appendAdminAudit,
}));

import { fromInput, fromResult } from "./admin-audit";
import { adminAudit } from "./admin-audit-middleware";

type ServerFn = (ctx: {
  data: unknown;
  next: () => Promise<unknown>;
}) => Promise<unknown>;

/** The middleware's `.server()` callback, as the framework would invoke it. */
function serverFnOf(middleware: ReturnType<typeof adminAudit>): ServerFn {
  return (middleware as unknown as { options: { server: ServerFn } }).options
    .server;
}

function lastRow(): NewAdminAuditLog {
  return mocks.appendAdminAudit.mock.calls.at(-1)![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getAdminSession.mockResolvedValue({
    user: { id: "admin-1", email: "root@example.com", role: "admin" },
    session: { id: "s1", impersonatedBy: null },
  });
  mocks.appendAdminAudit.mockResolvedValue(undefined);
  mocks.getRequest.mockReturnValue(
    new Request("https://blossom.test/_serverFn/x", {
      method: "POST",
      headers: { "x-real-ip": "9.9.9.9", "user-agent": "vitest-agent" },
    }),
  );
});

describe("adminAudit middleware", () => {
  const meta = { targetType: "user", targetId: fromInput("userId") } as const;

  it("records a success with actor, target, ip and user agent, and passes the result through", async () => {
    const result = { result: { id: "u1" }, context: {} };
    const next = vi.fn().mockResolvedValue(result);

    const out = await serverFnOf(adminAudit("user.ban", meta))({
      data: { userId: "u1", reason: "spam", password: "hunter2hunter2" },
      next,
    });

    expect(out).toBe(result);
    expect(mocks.appendAdminAudit).toHaveBeenCalledTimes(1);
    expect(lastRow()).toMatchObject({
      action: "user.ban",
      actorUserId: "admin-1",
      actorEmail: "root@example.com",
      targetType: "user",
      targetId: "u1",
      status: "success",
      ip: "9.9.9.9",
      userAgent: "vitest-agent",
      error: null,
    });
    expect(JSON.stringify(lastRow().input)).not.toContain("hunter2hunter2");
  });

  it("takes a created record's id from the handler result", async () => {
    await serverFnOf(
      adminAudit("rule.create", {
        targetType: "rule",
        targetId: fromResult("id"),
      }),
    )({
      data: { name: "block ads" },
      next: async () => ({ result: { id: "rule-9" } }),
    });
    expect(lastRow().targetId).toBe("rule-9");
  });

  it("records an error entry and rethrows the original error", async () => {
    const boom = new Error("Cannot ban yourself");
    await expect(
      serverFnOf(adminAudit("user.ban", meta))({
        data: { userId: "admin-1" },
        next: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(lastRow()).toMatchObject({
      status: "error",
      error: "Cannot ban yourself",
      targetId: "admin-1",
    });
  });

  it("never fails or alters the mutation when the audit write fails", async () => {
    mocks.appendAdminAudit.mockRejectedValue(new Error("db down"));
    const result = { result: { id: "u1" } };

    await expect(
      serverFnOf(adminAudit("user.ban", meta))({
        data: { userId: "u1" },
        next: async () => result,
      }),
    ).resolves.toBe(result);
    expect(console.error).toHaveBeenCalled();

    // ...and an error stays the handler's error, not the audit failure.
    const boom = new Error("handler failed");
    await expect(
      serverFnOf(adminAudit("user.ban", meta))({
        data: { userId: "u1" },
        next: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it("does not fail the mutation when the session lookup throws", async () => {
    mocks.getAdminSession.mockRejectedValue(new Error("auth down"));
    const result = { result: 1 };
    await expect(
      serverFnOf(adminAudit("user.ban", meta))({
        data: {},
        next: async () => result,
      }),
    ).resolves.toBe(result);
    expect(mocks.appendAdminAudit).not.toHaveBeenCalled();
  });

  it("records nothing without an admin session", async () => {
    mocks.getAdminSession.mockResolvedValue(null);
    const next = vi.fn().mockResolvedValue({ result: 1 });
    await serverFnOf(adminAudit("user.ban", meta))({ data: {}, next });
    expect(next).toHaveBeenCalled();
    expect(mocks.appendAdminAudit).not.toHaveBeenCalled();
  });

  it("marks an impersonated session", async () => {
    mocks.getAdminSession.mockResolvedValue({
      user: { id: "admin-1", email: "root@example.com", role: "admin" },
      session: { id: "s1", impersonatedBy: "admin-2" },
    });
    await serverFnOf(adminAudit("user.ban", meta))({
      data: { userId: "u1" },
      next: async () => ({ result: 1 }),
    });
    expect(lastRow().impersonatedBy).toBe("admin-2");
  });
});
