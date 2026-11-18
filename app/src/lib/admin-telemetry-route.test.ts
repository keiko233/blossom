import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(),
  select: vi.fn(),
  where: vi.fn(),
  requestTelemetry: vi.fn(),
}));

vi.mock("@/lib/ensure-admin", () => ({
  getAdminSession: mocks.getAdminSession,
}));
vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/realtime-hub", () => ({
  getRealtimeHub: () => ({ requestTelemetry: mocks.requestTelemetry }),
}));

import { Route } from "@/routes/api/admin/servers/$id/stream";

const handlers = Route.options.server?.handlers as
  | {
      GET: (context: {
        params: { id: string };
        request: Request;
      }) => Promise<Response>;
    }
  | undefined;
if (!handlers) throw new Error("Missing API route handlers");
const { GET } = handlers;

function request() {
  return GET({
    params: { id: "edge" },
    request: new Request("http://localhost/api/admin/servers/edge/stream"),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) });
});

describe("admin telemetry endpoint", () => {
  it("denies requests without an admin session before loading the server", async () => {
    mocks.getAdminSession.mockResolvedValue(null);
    const response = await request();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.requestTelemetry).not.toHaveBeenCalled();
  });

  it.each([
    { transport: "http", capabilities: ["telemetry-v1"], state: "fallback" },
    { transport: "ws", capabilities: ["ws-v1"], state: "legacy" },
  ])(
    "returns $state without contacting the agent",
    async ({ transport, capabilities, state }) => {
      mocks.getAdminSession.mockResolvedValue({ user: { role: "admin" } });
      mocks.where.mockResolvedValue([
        { enabled: true, transport, capabilities },
      ]);
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state });
      expect(mocks.requestTelemetry).not.toHaveBeenCalled();
    },
  );
});
