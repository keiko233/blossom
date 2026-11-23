import { describe, expect, it } from "vitest";

import type { Database } from "@/db";
import { generateEnrollmentGrant } from "@/lib/agent-enrollment";

import {
  handleAgentGithubProxy,
  parseGithubProxyTarget,
} from "./agent-github-proxy";

const ORIGIN = "https://blossom.example.test";

interface GrantRow {
  id: string;
  status: string;
  release: string | null;
  expiresAt: Date;
}

function fakeDb(row: GrantRow | null): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as unknown as Database;
}

function authedRequest(path: string, token: string, method = "GET"): Request {
  return new Request(`${ORIGIN}/api/agent/github/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("parseGithubProxyTarget", () => {
  it("accepts allowlisted repository release paths and binary assets", () => {
    expect(
      parseGithubProxyTarget(
        "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      ),
    ).toEqual({
      repo: "keiko233/blossom",
      upstreamUrl:
        "https://github.com/keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      kind: "asset",
      tag: "latest",
    });

    expect(parseGithubProxyTarget("sagernet/sing-box/releases/latest")).toEqual(
      {
        repo: "SagerNet/sing-box",
        upstreamUrl: "https://github.com/SagerNet/sing-box/releases/latest",
        kind: "tag-redirect",
        tag: "latest",
      },
    );

    expect(
      parseGithubProxyTarget(
        "SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-arm64-musl.tar.gz",
      ),
    ).toEqual({
      repo: "SagerNet/sing-box",
      upstreamUrl:
        "https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-arm64-musl.tar.gz",
      kind: "asset",
      tag: "v1.14.4",
    });

    expect(
      parseGithubProxyTarget("SagerNet/sing-box/releases/tag/v1.14.4"),
    ).toEqual({
      repo: "SagerNet/sing-box",
      upstreamUrl: "https://github.com/SagerNet/sing-box/releases/tag/v1.14.4",
      kind: "tag-page",
      tag: "v1.14.4",
    });
  });

  it("rejects non-allowlisted repos, unexpected assets, and traversal", () => {
    expect(parseGithubProxyTarget("other/repo/releases/latest")).toBeNull();
    expect(
      parseGithubProxyTarget("keiko233/blossom/archive/refs/heads/main.zip"),
    ).toBeNull();
    expect(
      parseGithubProxyTarget(
        "keiko233/blossom/releases/latest/download/something-else.zip",
      ),
    ).toBeNull();
    expect(
      parseGithubProxyTarget(
        "SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-darwin-arm64.tar.gz",
      ),
    ).toBeNull();
    expect(
      parseGithubProxyTarget("keiko233/blossom/releases/latest/download/.."),
    ).toBeNull();
    expect(parseGithubProxyTarget("")).toBeNull();
  });
});

describe("handleAgentGithubProxy", () => {
  const { secret } = generateEnrollmentGrant();
  const validRow: GrantRow = {
    id: "grant-1",
    status: "issued",
    release: "latest",
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("rejects non-GET/HEAD methods", async () => {
    const response = await handleAgentGithubProxy(
      authedRequest("keiko233/blossom/releases/latest", secret, "POST"),
      "keiko233/blossom/releases/latest",
      { db: fakeDb(validRow), publicOrigin: ORIGIN, disableRateLimit: true },
    );
    expect(response.status).toBe(405);
  });

  it("returns 401 when bearer grant is missing, malformed, redeemed, or expired", async () => {
    const missing = await handleAgentGithubProxy(
      new Request(
        `${ORIGIN}/api/agent/github/keiko233/blossom/releases/latest`,
      ),
      "keiko233/blossom/releases/latest",
      { db: fakeDb(validRow), publicOrigin: ORIGIN, disableRateLimit: true },
    );
    expect(missing.status).toBe(401);

    const redeemed = await handleAgentGithubProxy(
      authedRequest("keiko233/blossom/releases/latest", secret),
      "keiko233/blossom/releases/latest",
      {
        db: fakeDb({ ...validRow, status: "redeemed" }),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
      },
    );
    expect(redeemed.status).toBe(401);

    const expired = await handleAgentGithubProxy(
      authedRequest("keiko233/blossom/releases/latest", secret),
      "keiko233/blossom/releases/latest",
      {
        db: fakeDb({ ...validRow, expiresAt: new Date(Date.now() - 10_000) }),
        publicOrigin: ORIGIN,
        now: () => new Date(),
        disableRateLimit: true,
      },
    );
    expect(expired.status).toBe(401);
  });

  it("enforces pinned release version for server-agent downloads", async () => {
    const response = await handleAgentGithubProxy(
      authedRequest(
        "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
        secret,
      ),
      "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      {
        db: fakeDb({ ...validRow, release: "1.4.2" }),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
      },
    );
    expect(response.status).toBe(403);
  });

  it("enforces per-grant rate limiting", async () => {
    const freshGrant = generateEnrollmentGrant().secret;
    const path = "SagerNet/sing-box/releases/tag/v1.14.4";
    const deps = {
      db: fakeDb(validRow),
      publicOrigin: ORIGIN,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    };

    for (let i = 0; i < 20; i++) {
      const ok = await handleAgentGithubProxy(
        authedRequest(path, freshGrant),
        path,
        deps,
      );
      expect(ok.status).toBe(200);
    }

    const limited = await handleAgentGithubProxy(
      authedRequest(path, freshGrant),
      path,
      deps,
    );
    expect(limited.status).toBe(429);
  });

  it("returns 404 for disallowed paths without calling fetch", async () => {
    let called = false;
    const response = await handleAgentGithubProxy(
      authedRequest("evil/repo/releases/latest", secret),
      "evil/repo/releases/latest",
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async () => {
          called = true;
          return new Response("unexpected");
        },
      },
    );
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  it("rewrites /releases/latest redirects to the proxy tag URL", async () => {
    const response = await handleAgentGithubProxy(
      authedRequest("SagerNet/sing-box/releases/latest", secret),
      "SagerNet/sing-box/releases/latest",
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async (input, init) => {
          expect(input).toBe(
            "https://github.com/SagerNet/sing-box/releases/latest",
          );
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://github.com/SagerNet/sing-box/releases/tag/v1.14.4",
            },
          });
        },
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/api/agent/github/SagerNet/sing-box/releases/tag/v1.14.4`,
    );
  });

  it("follows allowlisted CDN redirects for asset downloads and streams the body", async () => {
    const calls: string[] = [];
    const response = await handleAgentGithubProxy(
      authedRequest(
        "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
        secret,
      ),
      "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async (input) => {
          const url = String(input);
          calls.push(url);
          if (calls.length === 1) {
            return new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://release-assets.githubusercontent.com/github-production-release-asset/123/server-agent-linux-amd64",
              },
            });
          }
          return new Response("binary-payload", {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": "14",
            },
          });
        },
      },
    );

    expect(calls).toEqual([
      "https://github.com/keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      "https://release-assets.githubusercontent.com/github-production-release-asset/123/server-agent-linux-amd64",
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("binary-payload");
  });

  it("blocks redirects to non-GitHub hosts and oversized assets", async () => {
    const badRedirect = await handleAgentGithubProxy(
      authedRequest(
        "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
        secret,
      ),
      "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "https://169.254.169.254/latest/meta-data/",
            },
          }),
      },
    );
    expect(badRedirect.status).toBe(502);

    const oversized = await handleAgentGithubProxy(
      authedRequest(
        "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
        secret,
      ),
      "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async () =>
          new Response("too-big", {
            status: 200,
            headers: {
              "content-length": String(200 * 1024 * 1024),
            },
          }),
      },
    );
    expect(oversized.status).toBe(502);
  });

  it("returns 502 when upstream fetch throws", async () => {
    const response = await handleAgentGithubProxy(
      authedRequest(
        "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
        secret,
      ),
      "keiko233/blossom/releases/latest/download/server-agent-linux-amd64",
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async () => {
          throw new Error("ETIMEDOUT");
        },
      },
    );
    expect(response.status).toBe(502);
  });
});
