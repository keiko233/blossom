import { describe, expect, it } from "vitest";

import type { Database } from "@/db";
import { generateEnrollmentGrant } from "@/lib/agent-enrollment";

import {
  bootstrapGrantToken,
  handleAgentBootstrap,
} from "./agent-bootstrap-route";

interface GrantRow {
  id: string;
  serverId: string | null;
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

function request(token: string, method = "GET"): Request {
  return new Request(`http://localhost:3000/api/agent/install/${token}`, {
    method,
  });
}

describe("bootstrapGrantToken", () => {
  it("strips only a trailing .sh", () => {
    expect(bootstrapGrantToken("egr_abc.sh")).toBe("egr_abc");
    expect(bootstrapGrantToken("egr_abc")).toBe("egr_abc");
    expect(bootstrapGrantToken("egr_abc.sh.sh")).toBe("egr_abc.sh");
  });
});

describe("handleAgentBootstrap", () => {
  const { secret, tokenHash } = generateEnrollmentGrant();
  const row: GrantRow = {
    id: "grant-1",
    serverId: null,
    status: "issued",
    release: "latest",
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("serves the one-line script for an issued, unexpired grant", async () => {
    const response = await handleAgentBootstrap(
      request(`${secret}.sh`),
      `${secret}.sh`,
      {
        db: fakeDb(row),
        publicOrigin: "http://localhost:3000",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/x-shellscript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).toContain(secret);
    expect(body).toContain("docker");
    expect(tokenHash).not.toContain(secret);
  });

  it("returns 404 for a malformed, unknown, redeemed, or expired link", async () => {
    const malformed = await handleAgentBootstrap(
      request("egr_short.sh"),
      "egr_short.sh",
      {
        db: fakeDb(row),
        publicOrigin: "http://localhost:3000",
      },
    );
    expect(malformed.status).toBe(404);

    const redeemed = await handleAgentBootstrap(
      request(`${secret}.sh`),
      `${secret}.sh`,
      {
        db: fakeDb({ ...row, status: "redeemed" }),
        publicOrigin: "http://localhost:3000",
      },
    );
    expect(redeemed.status).toBe(404);

    const expired = await handleAgentBootstrap(
      request(`${secret}.sh`),
      `${secret}.sh`,
      {
        db: fakeDb({ ...row, expiresAt: new Date(Date.now() - 60_000) }),
        publicOrigin: "http://localhost:3000",
        now: () => new Date(Date.now() + 60_000),
      },
    );
    expect(expired.status).toBe(404);
    for (const response of [malformed, redeemed, expired]) {
      expect(await response.text()).not.toContain(secret);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
