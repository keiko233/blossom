import { describe, expect, it } from "vitest";

import type { Database } from "@/db";
import { generateEnrollmentGrant } from "@/lib/agent-enrollment";

import {
  handleAgentGhcrToken,
  handleAgentGhcrV2,
  parseGhcrTarget,
} from "./agent-ghcr-proxy";

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

describe("parseGhcrTarget", () => {
  it("accepts ping, manifests, and blobs for keiko233/blossom/server-agent", () => {
    expect(parseGhcrTarget("")).toEqual({ kind: "ping" });
    expect(
      parseGhcrTarget("keiko233/blossom/server-agent/manifests/latest"),
    ).toEqual({ kind: "manifest", reference: "latest" });
    expect(
      parseGhcrTarget(
        `keiko233/blossom/server-agent/manifests/sha256:${"a".repeat(64)}`,
      ),
    ).toEqual({ kind: "manifest", reference: `sha256:${"a".repeat(64)}` });
    expect(
      parseGhcrTarget(
        `keiko233/blossom/server-agent/blobs/sha256:${"b".repeat(64)}`,
      ),
    ).toEqual({ kind: "blob", digest: `sha256:${"b".repeat(64)}` });
  });

  it("rejects other repositories, invalid digests, and traversal", () => {
    expect(parseGhcrTarget("other/repo/manifests/latest")).toBeNull();
    expect(
      parseGhcrTarget("keiko233/blossom/server-agent/manifests/.."),
    ).toBeNull();
    expect(
      parseGhcrTarget("keiko233/blossom/server-agent/blobs/not-a-digest"),
    ).toBeNull();
    expect(
      parseGhcrTarget("keiko233/blossom/server-agent/tags/list"),
    ).toBeNull();
  });
});

describe("handleAgentGhcrToken", () => {
  const { secret } = generateEnrollmentGrant();
  const validRow: GrantRow = {
    id: "grant-1",
    status: "issued",
    release: "latest",
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("issues a token for a valid Basic enrollment grant", async () => {
    const basic = btoa(`blossom:${secret}`);
    const response = await handleAgentGhcrToken(
      new Request(
        `${ORIGIN}/api/agent/ghcr/token?service=blossom-ghcr&scope=repository%3Akeiko233%2Fblossom%2Fserver-agent%3Apull`,
        { headers: { authorization: `Basic ${basic}` } },
      ),
      { db: fakeDb(validRow), publicOrigin: ORIGIN, disableRateLimit: true },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      expires_in: number;
    };
    expect(body.token).toBe(secret);
    expect(body.expires_in).toBe(300);
  });

  it("rejects disallowed scopes and invalid grants", async () => {
    const basic = btoa(`blossom:${secret}`);
    const badScope = await handleAgentGhcrToken(
      new Request(
        `${ORIGIN}/api/agent/ghcr/token?scope=repository%3Aother%2Fimage%3Apull`,
        { headers: { authorization: `Basic ${basic}` } },
      ),
      { db: fakeDb(validRow), publicOrigin: ORIGIN, disableRateLimit: true },
    );
    expect(badScope.status).toBe(403);

    const redeemed = await handleAgentGhcrToken(
      new Request(`${ORIGIN}/api/agent/ghcr/token`, {
        headers: { authorization: `Basic ${basic}` },
      }),
      {
        db: fakeDb({ ...validRow, status: "redeemed" }),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
      },
    );
    expect(redeemed.status).toBe(401);
  });
});

describe("handleAgentGhcrV2", () => {
  const { secret } = generateEnrollmentGrant();
  const validRow: GrantRow = {
    id: "grant-1",
    status: "issued",
    release: "latest",
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("returns 401 with Bearer challenge when unauthenticated", async () => {
    const response = await handleAgentGhcrV2(new Request(`${ORIGIN}/v2/`), "", {
      db: fakeDb(validRow),
      publicOrigin: ORIGIN,
      disableRateLimit: true,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `${ORIGIN}/api/agent/ghcr/token`,
    );
  });

  it("proxies manifests and strips GHCR auth on blob CDN redirects", async () => {
    const seenHeaders: Array<{ url: string; hasAuth: boolean }> = [];
    const digest = `sha256:${"c".repeat(64)}`;
    const response = await handleAgentGhcrV2(
      new Request(
        `${ORIGIN}/v2/keiko233/blossom/server-agent/blobs/${digest}`,
        {
          headers: { authorization: `Bearer ${secret}` },
        },
      ),
      `keiko233/blossom/server-agent/blobs/${digest}`,
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async (input, init) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          seenHeaders.push({ url, hasAuth: headers.has("authorization") });
          if (url.startsWith("https://ghcr.io/token")) {
            return new Response(JSON.stringify({ token: "ghcr-anon-token" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.startsWith("https://ghcr.io/v2/")) {
            return new Response(null, {
              status: 307,
              headers: {
                location:
                  "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:ccc",
              },
            });
          }
          return new Response("layer-bytes", {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": "11",
            },
          });
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("layer-bytes");
    expect(seenHeaders).toEqual([
      {
        url: "https://ghcr.io/token?service=ghcr.io&scope=repository%3Akeiko233%2Fblossom%2Fserver-agent%3Apull",
        hasAuth: false,
      },
      {
        url: `https://ghcr.io/v2/keiko233/blossom/server-agent/blobs/${digest}`,
        hasAuth: true,
      },
      {
        url: "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:ccc",
        hasAuth: false,
      },
    ]);
  });

  it("blocks disallowed blob redirect hosts", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const response = await handleAgentGhcrV2(
      new Request(
        `${ORIGIN}/v2/keiko233/blossom/server-agent/blobs/${digest}`,
        {
          headers: { authorization: `Bearer ${secret}` },
        },
      ),
      `keiko233/blossom/server-agent/blobs/${digest}`,
      {
        db: fakeDb(validRow),
        publicOrigin: ORIGIN,
        disableRateLimit: true,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.startsWith("https://ghcr.io/token")) {
            return new Response(JSON.stringify({ token: "ghcr-anon-token" }), {
              status: 200,
            });
          }
          return new Response(null, {
            status: 307,
            headers: { location: "https://169.254.169.254/latest/meta-data/" },
          });
        },
      },
    );
    expect(response.status).toBe(502);
  });
});
