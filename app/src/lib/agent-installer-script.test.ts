import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseApprovedAgentReleases } from "./agent-installer-release";
import { renderAgentInstallerScript } from "./agent-installer-script";

const grant = `egr_${"A".repeat(43)}`;
const manifest = parseApprovedAgentReleases([
  {
    schemaVersion: 1,
    version: "1.4.0",
    tag: "v1.4.0",
    installerContract: 1,
    agent: {
      capabilities: [
        "credentials-file-v1",
        "oauth-enrollment-cli-v1",
        "oauth-ws-v1",
        "pty-v1",
      ],
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
  },
])[0]!;

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function render(enrollmentGrant?: string, capabilities = ["pty-v1"]): string {
  return renderAgentInstallerScript({
    publicOrigin: "https://blossom.example.com",
    serverId: "server-1",
    grantId: "grant-1",
    mode: "enroll",
    capabilities,
    release: manifest,
    ...(enrollmentGrant === undefined ? {} : { enrollmentGrant }),
  });
}

function assertShellSyntax(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "blossom-installer-syntax-"));
  cleanup.push(dir);
  const path = join(dir, "install.sh");
  writeFileSync(path, script);
  const result = spawnSync("sh", ["-n", path], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("systemd installer script", () => {
  it("renders a fixed POSIX shell script with both approved architectures", () => {
    const script = render();

    assertShellSyntax(script);
    expect(script).toContain(
      "https://github.com/example/blossom/server-agent-linux-amd64",
    );
    expect(script).toContain(
      "https://github.com/example/blossom/server-agent-linux-arm64",
    );
    expect(script).toContain("User=$SERVICE_USER");
    expect(script).toContain("Group=$SERVICE_GROUP");
    expect(script).toContain("ProtectSystem=strict");
    expect(script).toContain("--credentials-file $CREDENTIALS_FILE");
    expect(script).toContain("--self-update=false --pty-enabled");
    expect(script).toContain("sha256sum");
    expect(script).not.toMatch(/^set -x$/m);
    expect(script).not.toContain("@@");
  });

  it("embeds a one-time grant only for inline delivery", () => {
    const inline = render(grant);
    const stdin = render();

    assertShellSyntax(inline);
    assertShellSyntax(stdin);
    expect(inline).toContain(grant);
    expect(stdin).not.toContain(grant);
    expect(stdin).toContain("BLOSSOM_GRANT_STDIN");
    expect(stdin).toContain("--grant-file");
    expect(stdin).not.toContain(`--grant ${grant}`);
  });

  it("enables PTY for the v2 websocket capability", () => {
    const script = render(undefined, ["pty-v2"]);

    assertShellSyntax(script);
    expect(script).toContain(" --pty-enabled");
  });

  it("omits the PTY flag when the grant did not select it", () => {
    expect(render(undefined, [])).not.toContain("--pty-enabled");
  });

  it("rejects non-HTTPS origins, unsafe identifiers and malformed grants", () => {
    expect(() =>
      renderAgentInstallerScript({
        publicOrigin: "http://blossom.example.com",
        serverId: "server-1",
        grantId: "grant-1",
        mode: "enroll",
        capabilities: [],
        release: manifest,
      }),
    ).toThrow("plain HTTPS origin");

    expect(() =>
      renderAgentInstallerScript({
        publicOrigin: "https://blossom.example.com",
        serverId: "server;rm -rf /",
        grantId: "grant-1",
        mode: "enroll",
        capabilities: [],
        release: manifest,
      }),
    ).toThrow("serverId");

    expect(() => render("egr_short")).toThrow("malformed");
  });
});
