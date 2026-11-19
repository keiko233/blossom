import { describe, expect, it } from "vitest";

import {
  AGENT_INSTALLER_REQUIRED_CAPABILITIES,
  InstallerReleaseError,
  isAgentReleaseCompatible,
  parseApprovedAgentReleases,
  selectApprovedAgentRelease,
} from "./agent-installer-release";

const sha = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version: "1.4.0",
    tag: "v1.4.0",
    installerContract: 1,
    agent: {
      capabilities: [...AGENT_INSTALLER_REQUIRED_CAPABILITIES, "pty-v1"],
      assets: {
        amd64: {
          url: "https://github.com/example/blossom/releases/download/v1.4.0/server-agent-linux-amd64",
          sha256: sha,
        },
        arm64: {
          url: "https://github.com/example/blossom/releases/download/v1.4.0/server-agent-linux-arm64",
          sha256: "b".repeat(64),
        },
      },
    },
    singBox: {
      version: "1.14.4",
      assets: {
        amd64: {
          url: "https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64-musl.tar.gz",
          sha256: "c".repeat(64),
        },
        arm64: {
          url: "https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-arm64-musl.tar.gz",
          sha256: "d".repeat(64),
        },
      },
    },
    ...overrides,
  };
}

describe("approved agent installer releases", () => {
  it("parses an approved manifest and selects the newest compatible entry", () => {
    const releases = parseApprovedAgentReleases([manifest()]);

    expect(releases).toHaveLength(1);
    expect(isAgentReleaseCompatible(releases[0]!)).toBe(true);
    expect(selectApprovedAgentRelease(releases, null).version).toBe("1.4.0");
    expect(selectApprovedAgentRelease(releases, "v1.4.0").version).toBe(
      "1.4.0",
    );
  });

  it("refuses an unapproved version", () => {
    const releases = parseApprovedAgentReleases([manifest()]);

    expect(() => selectApprovedAgentRelease(releases, "1.4.1")).toThrowError(
      InstallerReleaseError,
    );
  });

  it("refuses a release without the capabilities this installer requires", () => {
    const releases = parseApprovedAgentReleases([
      manifest({
        agent: {
          capabilities: ["credentials-file-v1", "oauth-enrollment-cli-v1"],
          assets: manifest().agent.assets,
        },
      }),
    ]);

    expect(isAgentReleaseCompatible(releases[0]!)).toBe(false);
    expect(() => selectApprovedAgentRelease(releases, null)).toThrowError(
      expect.objectContaining({ code: "no_approved_release" }),
    );
    expect(() => selectApprovedAgentRelease(releases, "1.4.0")).toThrowError(
      expect.objectContaining({ code: "release_incompatible" }),
    );
  });

  it("rejects duplicate versions, mismatched tags and non-HTTPS assets", () => {
    expect(() => parseApprovedAgentReleases([manifest(), manifest()])).toThrow(
      "Duplicate approved agent release",
    );

    expect(() =>
      parseApprovedAgentReleases([manifest({ tag: "v9.9.9" })]),
    ).toThrow();
    expect(() =>
      parseApprovedAgentReleases([manifest({ tag: "server-agent-v1.4.0" })]),
    ).toThrow();

    const insecure = manifest();
    insecure.agent.assets.amd64.url =
      "http://github.com/example/blossom/server-agent";
    expect(() => parseApprovedAgentReleases([insecure])).toThrow();

    const credentialed = manifest();
    credentialed.agent.assets.amd64.url =
      "https://user:value@github.com/example/blossom/server-agent";
    expect(() => parseApprovedAgentReleases([credentialed])).toThrow();
  });

  it("rejects duplicate architectures and malformed digests", () => {
    const shortDigest = manifest();
    shortDigest.agent.assets.amd64.sha256 = "abc";
    expect(() => parseApprovedAgentReleases([shortDigest])).toThrow();

    const extraAsset = manifest();
    Object.assign(extraAsset.agent.assets, {
      riscv64: {
        url: "https://github.com/example/blossom/server-agent-riscv64",
        sha256: sha,
      },
    });
    expect(() => parseApprovedAgentReleases([extraAsset])).toThrow();
  });
});
