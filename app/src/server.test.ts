import { describe, expect, it, vi } from "vitest";

import { getLocale } from "@/paraglide/runtime";

vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://verify:verify@127.0.0.1:5432/verify";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
});

const maintenance = vi.hoisted(() => ({
  token: "scheduled-maintenance-token" as string | undefined,
  calls: [] as { path: string; method: string; authorization: string | null }[],
}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    MAINTENANCE_TOKEN: maintenance.token,
    BETTER_AUTH_URL: "http://localhost:3000",
  }),
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/maintenance/")) {
        maintenance.calls.push({
          path: pathname,
          method: request.method,
          authorization: request.headers.get("authorization"),
        });
        return pathname.endsWith("/managed-rollouts")
          ? new Response(null, { status: 500 })
          : new Response("{}");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(getLocale());
    },
  },
}));

import server from "./server";

describe("server locale handling", () => {
  it("isolates concurrent request locales and varies the response by cookie", async () => {
    const responses = await Promise.all(
      ["en", "zh-cn"].map((locale) =>
        server.fetch(
          new Request("http://localhost/", {
            headers: { cookie: `PARAGLIDE_LOCALE=${locale}` },
          }),
        ),
      ),
    );
    expect(
      await Promise.all(responses.map((response) => response.text())),
    ).toEqual(["en", "zh-cn"]);
    for (const response of responses) {
      expect(response.headers.get("vary")).toContain("Cookie");
    }
  });
});

describe("server scheduled handler", () => {
  it("runs every maintenance sweep with the token and survives a failing one", async () => {
    maintenance.calls.length = 0;
    const pending: Promise<unknown>[] = [];
    server.scheduled({}, {}, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);

    expect(maintenance.calls).toEqual(
      [
        "/api/maintenance/server-metrics",
        "/api/maintenance/managed-rollouts",
        "/api/maintenance/certificates",
      ].map((path) => ({
        path,
        method: "POST",
        authorization: "Bearer scheduled-maintenance-token",
      })),
    );
  });

  it("skips the sweeps when no maintenance token is configured", async () => {
    maintenance.calls.length = 0;
    maintenance.token = undefined;
    try {
      const pending: Promise<unknown>[] = [];
      server.scheduled(
        {},
        {},
        { waitUntil: (promise) => pending.push(promise) },
      );
      await Promise.all(pending);
      expect(maintenance.calls).toEqual([]);
    } finally {
      maintenance.token = "scheduled-maintenance-token";
    }
  });
});
