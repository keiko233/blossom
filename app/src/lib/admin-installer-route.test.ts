import { describe, expect, it } from "vitest";

import { handleAdminInstallerDownload } from "./admin-installer-route";
import { AGENT_INSTALLER_REQUIRED_CAPABILITIES } from "./agent-installer-release";

const ORIGIN = "https://blossom.example.com";
const SERVER_ID = "server-1";
const GRANT_ID = "grant-1";
const PATH = `/api/admin/servers/${SERVER_ID}/installation/script/${GRANT_ID}`;

const manifest = {
  schemaVersion: 1,
  version: "1.4.0",
  tag: "v1.4.0",
  installerContract: 1,
  agent: {
    capabilities: [...AGENT_INSTALLER_REQUIRED_CAPABILITIES],
    assets: {
      amd64: {
        url: "https://github.com/example/blossom/server-agent-linux-amd64",
        sha256: "a".repeat(64),
      },
      arm64: {
        url: "https://github.com/example/blossom/server-agent-linux-arm64",
        sha256: "b".repeat(64),
      },
    },
  },
  singBox: {
    version: "1.14.4",
    assets: {
      amd64: {
        url: "https://github.com/SagerNet/sing-box/sing-box-1.14.4-linux-amd64-musl.tar.gz",
        sha256: "c".repeat(64),
      },
      arm64: {
        url: "https://github.com/SagerNet/sing-box/sing-box-1.14.4-linux-arm64-musl.tar.gz",
        sha256: "d".repeat(64),
      },
    },
  },
};

function request(path = PATH, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: { "sec-fetch-site": "same-origin", ...headers },
  });
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID,
    serverId: SERVER_ID,
    mode: "enroll" as const,
    capabilities: [],
    release: "1.4.0",
    status: "issued",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

async function run(
  options: {
    path?: string;
    headers?: Record<string, string>;
    admin?: boolean;
    loadedGrant?: ReturnType<typeof grant> | null;
    releases?: readonly unknown[];
    now?: Date;
  } = {},
) {
  return handleAdminInstallerDownload(
    request(options.path, options.headers),
    { serverId: SERVER_ID, grantId: GRANT_ID },
    {
      publicOrigin: ORIGIN,
      approvedReleases: options.releases ?? [manifest],
      authenticate: async () =>
        options.admin === false ? null : { user: { role: "admin" } },
      loadGrant: async () =>
        options.loadedGrant === undefined ? grant() : options.loadedGrant,
      now: () => options.now ?? new Date(),
    },
  );
}

describe("admin installer download route", () => {
  it("returns the secret-free script as a no-store attachment", async () => {
    const response = await run();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="blossom-agent-install.sh"',
    );
    const body = await response.text();
    expect(body).toContain(SERVER_ID);
    expect(body).toContain("User=$SERVICE_USER");
    expect(body).toContain("BLOSSOM_GRANT_STDIN");
    expect(body).not.toContain("enrollment_grant='egr_");
  });

  it("rejects non-admin and cross-site callers with no-store errors", async () => {
    const unauthenticated = await run({ admin: false });
    const crossSite = await run({
      headers: { "sec-fetch-site": "cross-site" },
    });
    const crossOrigin = await run({
      headers: { origin: "https://attacker.example" },
    });

    expect(unauthenticated.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(unauthenticated.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("rejects a grant that does not belong to the server", async () => {
    const response = await run({ loadedGrant: null });

    expect(response.status).toBe(404);
  });

  it("refuses spent or expired grants and missing release pins", async () => {
    const spent = await run({ loadedGrant: grant({ status: "redeemed" }) });
    const expired = await run({
      loadedGrant: grant({ expiresAt: new Date("2020-01-01T00:00:00Z") }),
    });
    const unpinned = await run({ loadedGrant: grant({ release: null }) });

    expect(spent.status).toBe(409);
    expect(expired.status).toBe(409);
    expect(unpinned.status).toBe(409);
  });

  it("gates on an approved compatible release", async () => {
    const none = await run({ releases: [] });
    const invalid = await run({ releases: [{ version: "bad" }] });
    const unapproved = await run({
      loadedGrant: grant({ release: "1.4.1" }),
    });

    expect(none.status).toBe(409);
    expect(invalid.status).toBe(503);
    expect(unapproved.status).toBe(409);
  });

  it("only accepts the fixed path with no query parameters", async () => {
    const alternate = await run({
      path: `/api/admin/servers/${SERVER_ID}/installation/script/${GRANT_ID}/extra`,
    });
    const query = await run({ path: `${PATH}?grant=secret` });

    expect(alternate.status).toBe(404);
    expect(query.status).toBe(404);
  });
});
