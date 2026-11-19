import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseApprovedAgentReleases } from "./agent-installer-release";
import { renderAgentInstallerScript } from "./agent-installer-script";

const grant = `egr_${"B".repeat(43)}`;
const origin = "https://blossom.example.com";
const serverId = "server-e2e";
const grantId = "grant-e2e";
const agentUrl =
  "https://github.com/example/blossom/server-agent-linux-amd64-e2e";
const singBoxUrl =
  "https://github.com/SagerNet/sing-box/sing-box-1.14.4-linux-amd64-musl-e2e.tar.gz";
const user = process.env.USER ?? process.env.LOGNAME ?? "root";
const group =
  spawnSync("id", ["-gn", user], { encoding: "utf8" }).stdout.trim() || user;

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

interface Sandbox {
  root: string;
  fakeBin: string;
  state: string;
  agentUrl: string;
  singBoxUrl: string;
  agentArchive: string;
  singBoxArchive: string;
}

function createSandbox(options: { architecture?: string } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "blossom-installer-e2e-"));
  cleanup.push(root);
  const fakeBin = join(root, "fake-bin");
  const state = join(root, "fake-state");
  const fixtures = join(root, "fixtures");
  for (const dir of [
    fakeBin,
    state,
    fixtures,
    join(root, "etc/systemd/system"),
    join(root, "usr/local/lib"),
    join(root, "var/lib"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const agent = join(fixtures, "server-agent");
  writeExecutable(
    agent,
    `#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  echo "server-agent 1.4.0"
  exit 0
fi
if [ "$1" = "enroll" ]; then
  shift
  grant_file=
  credentials_file=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --url) url=$2; shift 2 ;;
      --grant-file) grant_file=$2; shift 2 ;;
      --credentials-file) credentials_file=$2; shift 2 ;;
      *) exit 64 ;;
    esac
  done
  [ -n "$grant_file" ] || exit 65
  [ -n "$credentials_file" ] || exit 65
  [ "$(stat -c %a "$grant_file")" = 600 ] || exit 66
  [ "$(wc -l <"$grant_file")" -eq 1 ] || exit 67
  grep -q '^egr_\\{1\\}[A-Za-z0-9_-]\\{43\\}$' "$grant_file" || exit 68
  printf '%s\\n' "$url $grant_file $credentials_file" >>"$FAKE_STATE/agent-argv"
  cat >"$credentials_file" <<'JSON'
{"serverId":"server-e2e","identityId":"identity-e2e","generation":1,"clientId":"agent_fixture","clientSecret":"ags_fixture","clientAuthMethod":"client_secret_basic","grantType":"client_credentials","tokenEndpoint":"https://blossom.example.com/api/auth/oauth2/token","issuer":"https://blossom.example.com/api/auth","resource":"https://blossom.example.com/api/agent","scope":"blossom:agent:connect","tokenLifetimeSeconds":900}
JSON
  chmod 600 "$credentials_file"
  printf 'enroll\\n' >>"$FAKE_STATE/enroll-count"
  exit 0
fi
exit 1
`,
  );
  const singBox = join(fixtures, "sing-box");
  writeExecutable(
    singBox,
    `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "sing-box version 1.14.4"
  exit 0
fi
exit 1
`,
  );
  const singBoxArchive = join(fixtures, "sing-box.tar.gz");
  const tar = spawnSync(
    "tar",
    ["-czf", singBoxArchive, "-C", fixtures, "sing-box"],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) {
    throw new Error(tar.stderr);
  }

  writeExecutable(
    join(fakeBin, "curl"),
    `#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output=$2; shift 2 ;;
    --proto|--proto-redir|--retry|--retry-delay|--connect-timeout|--max-time)
      shift 2
      ;;
    --fail|--show-error|--silent|--location|--tlsv1.2) shift ;;
    *) url=$1; shift ;;
  esac
done
[ -n "$output" ] || exit 64
printf '%s\\n' "$url" >>"$FAKE_STATE/curl.log"
case "$url" in
  "$FAKE_AGENT_URL") cp "$FAKE_AGENT" "$output" ;;
  "$FAKE_SING_BOX_URL") cp "$FAKE_SING_BOX_ARCHIVE" "$output" ;;
  *) exit 22 ;;
esac
`,
  );
  writeExecutable(
    join(fakeBin, "systemctl"),
    `#!/bin/sh
set -eu
command=$1
shift || true
printf '%s\\n' "$command" >>"$FAKE_STATE/systemctl.log"
case "$command" in
  --version) echo "systemd 255"; exit 0 ;;
  daemon-reload|enable|disable) exit 0 ;;
  stop) rm -f "$FAKE_STATE/active"; exit 0 ;;
  start|restart)
    if [ -f "$FAKE_STATE/fail-start" ]; then
      rm -f "$FAKE_STATE/fail-start"
      exit 1
    fi
    touch "$FAKE_STATE/active"
    exit 0
    ;;
  is-active) [ -f "$FAKE_STATE/active" ] && exit 0 || exit 3 ;;
  status) echo "fake blossom-agent active"; exit 0 ;;
  *) exit 64 ;;
esac
`,
  );
  writeExecutable(
    join(fakeBin, "uname"),
    `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo ${options.architecture ?? "x86_64"} ;;
  *) exit 64 ;;
esac
`,
  );
  writeExecutable(
    join(fakeBin, "id"),
    `#!/bin/sh
case "$1" in
  -u) echo 0; exit 0 ;;
  -gn) echo ${group}; exit 0 ;;
  *) exit 0 ;;
esac
`,
  );

  return {
    root,
    fakeBin,
    state,
    agentUrl,
    singBoxUrl,
    agentArchive: agent,
    singBoxArchive,
  };
}

function manifest(sandbox: Sandbox, version = "1.4.0") {
  return parseApprovedAgentReleases([
    {
      schemaVersion: 1,
      version,
      tag: `v${version}`,
      installerContract: 1,
      agent: {
        capabilities: [
          "credentials-file-v1",
          "oauth-enrollment-cli-v1",
          "oauth-ws-v1",
        ],
        assets: {
          amd64: {
            url: sandbox.agentUrl,
            sha256: sha256(sandbox.agentArchive),
          },
          arm64: {
            url: sandbox.agentUrl,
            sha256: sha256(sandbox.agentArchive),
          },
        },
      },
      singBox: {
        version: "1.14.4",
        assets: {
          amd64: {
            url: sandbox.singBoxUrl,
            sha256: sha256(sandbox.singBoxArchive),
          },
          arm64: {
            url: sandbox.singBoxUrl,
            sha256: sha256(sandbox.singBoxArchive),
          },
        },
      },
    },
  ])[0]!;
}

function sandboxScript(
  sandbox: Sandbox,
  options: {
    inline: boolean;
    version?: string;
    serverId?: string;
    tamperDigest?: boolean;
  },
): string {
  const release = manifest(sandbox, options.version ?? "1.4.0");
  if (options.tamperDigest) {
    release.agent.assets.amd64.sha256 = "e".repeat(64);
  }
  const script = renderAgentInstallerScript({
    publicOrigin: origin,
    serverId: options.serverId ?? serverId,
    grantId,
    mode: "enroll",
    capabilities: [],
    release,
    ...(options.inline ? { enrollmentGrant: grant } : {}),
  });
  return script
    .replaceAll(
      "/usr/local/lib/blossom-agent",
      join(sandbox.root, "usr/local/lib/blossom-agent"),
    )
    .replaceAll("/etc/blossom-agent", join(sandbox.root, "etc/blossom-agent"))
    .replaceAll("/etc/systemd/system", join(sandbox.root, "etc/systemd/system"))
    .replaceAll(
      "/var/lib/blossom-agent",
      join(sandbox.root, "var/lib/blossom-agent"),
    )
    .replace(
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      `PATH=${sandbox.fakeBin}:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll("SERVICE_USER=blossom-agent", `SERVICE_USER=${user}`)
    .replaceAll("SERVICE_GROUP=blossom-agent", `SERVICE_GROUP=${group}`)
    .replaceAll("userdel blossom-agent", `userdel ${user}`);
}

function runInstaller(
  sandbox: Sandbox,
  script: string,
  options: {
    stdin?: string;
    confirm?: string;
  } = {},
) {
  const scriptPath = join(sandbox.root, "install.sh");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o700);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_STATE: sandbox.state,
    FAKE_AGENT_URL: sandbox.agentUrl,
    FAKE_AGENT: sandbox.agentArchive,
    FAKE_SING_BOX_URL: sandbox.singBoxUrl,
    FAKE_SING_BOX_ARCHIVE: sandbox.singBoxArchive,
    BLOSSOM_INSTALL_HEALTH_SECONDS: "0",
  };
  if (options.confirm) env.BLOSSOM_INSTALL_CONFIRM = options.confirm;
  if (options.stdin) env.BLOSSOM_GRANT_STDIN = "1";
  return spawnSync("sh", [scriptPath], {
    encoding: "utf8",
    env,
    input: options.stdin,
  });
}

function paths(root: string) {
  return {
    agent: join(root, "usr/local/lib/blossom-agent/server-agent"),
    singBox: join(root, "usr/local/lib/blossom-agent/sing-box"),
    unit: join(root, "etc/systemd/system/blossom-agent.service"),
    credentials: join(root, "etc/blossom-agent/credentials.json"),
    metadata: join(root, "etc/blossom-agent/installation.json"),
    state: join(root, "var/lib/blossom-agent"),
  };
}

describe("systemd installer sandbox", () => {
  it("installs verified fake artifacts with non-root service settings", () => {
    const sandbox = createSandbox();
    const script = sandboxScript(sandbox, { inline: false });
    const result = runInstaller(sandbox, script, { stdin: `${grant}\n` });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain(grant);
    const files = paths(sandbox.root);
    expect(readFileSync(files.agent, "utf8")).toBe(
      readFileSync(sandbox.agentArchive, "utf8"),
    );
    expect(readFileSync(files.singBox, "utf8")).toContain("sing-box version");
    expect(statSync(files.credentials).mode & 0o777).toBe(0o600);
    expect(statSync(files.state).mode & 0o777).toBe(0o700);
    expect(readFileSync(files.unit, "utf8")).toContain(`User=${user}`);
    expect(readFileSync(files.unit, "utf8")).toContain("ProtectSystem=strict");
    expect(readFileSync(files.unit, "utf8")).toContain(
      join(sandbox.root, "etc/blossom-agent/credentials.json"),
    );
    expect(readFileSync(files.credentials, "utf8")).toContain("clientSecret");
    expect(readFileSync(files.metadata, "utf8")).toContain(
      `grant_id=${grantId}`,
    );
    expect(readFileSync(join(sandbox.state, "enroll-count"), "utf8")).toBe(
      "enroll\n",
    );
    expect(
      readFileSync(join(sandbox.state, "agent-argv"), "utf8"),
    ).not.toContain(grant);
    expect(
      readdirSync(join(sandbox.root, "usr/local/lib/blossom-agent")).some(
        (name) => name.startsWith(".install."),
      ),
    ).toBe(false);
  });

  it("is idempotent when the same grant is already installed", () => {
    const sandbox = createSandbox();
    const script = sandboxScript(sandbox, { inline: true });

    expect(runInstaller(sandbox, script).status).toBe(0);
    const downloads = readFileSync(join(sandbox.state, "curl.log"), "utf8");
    const enrollments = readFileSync(
      join(sandbox.state, "enroll-count"),
      "utf8",
    );

    const rerun = runInstaller(sandbox, script);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readFileSync(join(sandbox.state, "curl.log"), "utf8")).toBe(
      downloads,
    );
    expect(readFileSync(join(sandbox.state, "enroll-count"), "utf8")).toBe(
      enrollments,
    );
  });

  it("refuses a different installation without explicit replacement", () => {
    const sandbox = createSandbox();
    const script = sandboxScript(sandbox, { inline: true });
    expect(runInstaller(sandbox, script).status).toBe(0);

    const different = sandboxScript(sandbox, {
      inline: true,
      serverId: "another-server",
    });
    const result = runInstaller(sandbox, different);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BLOSSOM_INSTALL_CONFIRM=replace");
    expect(readFileSync(join(sandbox.state, "enroll-count"), "utf8")).toBe(
      "enroll\n",
    );
  });

  it("fails unsupported architectures before downloading anything", () => {
    const sandbox = createSandbox({ architecture: "riscv64" });
    const result = runInstaller(
      sandbox,
      sandboxScript(sandbox, { inline: true }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported architecture");
    expect(existsSync(join(sandbox.state, "curl.log"))).toBe(false);
    expect(existsSync(paths(sandbox.root).agent)).toBe(false);
  });

  it("rejects a digest mismatch before redeeming the grant", () => {
    const sandbox = createSandbox();
    const result = runInstaller(
      sandbox,
      sandboxScript(sandbox, { inline: true, tamperDigest: true }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SHA-256 mismatch");
    expect(existsSync(join(sandbox.state, "enroll-count"))).toBe(false);
    expect(existsSync(paths(sandbox.root).credentials)).toBe(false);
  });

  it("restores binaries, credentials and identity metadata on failure", () => {
    const sandbox = createSandbox();
    const files = paths(sandbox.root);
    mkdirSync(join(sandbox.root, "etc/blossom-agent"), { recursive: true });
    mkdirSync(join(sandbox.root, "usr/local/lib/blossom-agent"), {
      recursive: true,
    });
    mkdirSync(files.state, { recursive: true, mode: 0o700 });
    writeFileSync(files.agent, "old-agent\n");
    chmodSync(files.agent, 0o755);
    writeFileSync(files.singBox, "old-sing-box\n");
    chmodSync(files.singBox, 0o755);
    writeFileSync(files.unit, "[Service]\nUser=old\n");
    writeFileSync(
      files.credentials,
      '{"clientId":"old","clientSecret":"old"}\n',
    );
    chmodSync(files.credentials, 0o600);
    writeFileSync(
      files.metadata,
      `server_id=${serverId}\norigin=${origin}\nrelease=1.3.0\ngrant_id=old-grant\nmode=enroll\n`,
    );
    writeFileSync(join(sandbox.state, "active"), "");
    writeFileSync(join(sandbox.state, "fail-start"), "");

    const result = runInstaller(
      sandbox,
      sandboxScript(sandbox, { inline: true, version: "1.4.0" }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restoring the previous service");
    expect(readFileSync(files.agent, "utf8")).toBe("old-agent\n");
    expect(readFileSync(files.singBox, "utf8")).toBe("old-sing-box\n");
    expect(readFileSync(files.credentials, "utf8")).toContain(
      '"clientId":"old"',
    );
    expect(readFileSync(files.metadata, "utf8")).toContain(
      "grant_id=old-grant",
    );
    expect(existsSync(join(sandbox.state, "active"))).toBe(true);
    expect(
      readdirSync(join(sandbox.root, "usr/local/lib/blossom-agent")).some(
        (name) => name.startsWith(".install."),
      ),
    ).toBe(false);
  });
});
