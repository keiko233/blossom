import { describe, expect, it, vi } from "vitest";

import type { AgentReleaseManifest } from "@/lib/agent-installer-release";

import {
  listAgentReleaseVersions,
  resetAgentReleaseVersionCache,
} from "./agent-release-feed";

const approved: AgentReleaseManifest = {
  schemaVersion: 1,
  version: "1.3.0",
  tag: "v1.3.0",
  installerContract: 1,
  agent: {
    capabilities: ["credentials-file-v1"],
    assets: {
      amd64: { url: "https://example.test/a", sha256: "a".repeat(64) },
      arm64: { url: "https://example.test/b", sha256: "b".repeat(64) },
    },
  },
  singBox: {
    version: "1.10.0",
    assets: {
      amd64: { url: "https://example.test/c", sha256: "c".repeat(64) },
      arm64: { url: "https://example.test/d", sha256: "d".repeat(64) },
    },
  },
};

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

describe("listAgentReleaseVersions", () => {
  it("lists latest first, drops drafts and non-semver tags, and merges approved", async () => {
    resetAgentReleaseVersionCache();
    const versions = await listAgentReleaseVersions({
      approved: [approved],
      fetchImpl: vi.fn(async () =>
        response([
          { tag_name: "v1.5.0", draft: false, prerelease: false },
          { tag_name: "v1.6.0-beta.1", draft: false, prerelease: true },
          { tag_name: "v1.4.0", draft: true, prerelease: false },
          { tag_name: "nightly", draft: false, prerelease: false },
          { tag_name: "v1.3.0", draft: false, prerelease: false },
        ]),
      ),
      useCache: false,
    });
    expect(versions.map((version) => version.value)).toEqual([
      "latest",
      "1.5.0",
      "1.6.0-beta.1",
      "1.3.0",
    ]);
    expect(versions.find((version) => version.value === "1.3.0")?.tag).toBe(
      "v1.3.0",
    );
  });

  it("falls back to latest plus approved when GitHub fails", async () => {
    resetAgentReleaseVersionCache();
    const versions = await listAgentReleaseVersions({
      approved: [approved],
      fetchImpl: vi.fn(async () => response({}, false)),
      useCache: false,
    });
    expect(versions.map((version) => version.value)).toEqual([
      "latest",
      "1.3.0",
    ]);
  });

  it("reuses the cached GitHub list for five minutes", async () => {
    resetAgentReleaseVersionCache();
    let now = 0;
    const fetchImpl = vi.fn(async () =>
      response([{ tag_name: "v1.5.0", draft: false, prerelease: false }]),
    );
    await listAgentReleaseVersions({ approved: [], fetchImpl, now: () => now });
    now = 4 * 60_000;
    await listAgentReleaseVersions({ approved: [], fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 6 * 60_000;
    await listAgentReleaseVersions({ approved: [], fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
