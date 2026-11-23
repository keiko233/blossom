import type { AgentEnrollmentMode } from "@/db/agent-identity-schema";
import type { AgentReleaseManifest } from "@/lib/agent-installer-release";
import template from "@/lib/agent-installer-template.sh?raw";

export interface InstallerScriptInput {
  /** Canonical public control-plane origin, without a trailing slash. */
  publicOrigin: string;
  serverId: string;
  grantId: string;
  mode: AgentEnrollmentMode;
  capabilities: readonly string[];
  release: AgentReleaseManifest;
  /** Present only for the one-time inline create action. */
  enrollmentGrant?: string;
}

const ENROLLMENT_GRANT_PATTERN = /^egr_[A-Za-z0-9_-]{43}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function assertInstallerIdentifier(name: string, value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
}

export function assertInstallerOrigin(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  if (
    url.protocol !== "https:" ||
    url.origin !== publicOrigin.replace(/\/$/, "")
  ) {
    throw new Error("The installer origin must be a plain HTTPS origin");
  }
  return url.origin;
}

export function renderAgentInstallerScript(
  input: InstallerScriptInput,
): string {
  const origin = assertInstallerOrigin(input.publicOrigin);
  assertInstallerIdentifier("serverId", input.serverId);
  assertInstallerIdentifier("grantId", input.grantId);
  if (
    input.enrollmentGrant !== undefined &&
    !ENROLLMENT_GRANT_PATTERN.test(input.enrollmentGrant)
  ) {
    throw new Error("The enrollment grant is malformed");
  }

  const amd64 = input.release.agent.assets.amd64;
  const arm64 = input.release.agent.assets.arm64;
  const singBoxAmd64 = input.release.singBox.assets.amd64;
  const singBoxArm64 = input.release.singBox.assets.arm64;

  const values: Record<string, string> = {
    ORIGIN: shellQuote(origin),
    SERVER_ID: shellQuote(input.serverId),
    GRANT_ID: shellQuote(input.grantId),
    MODE: shellQuote(input.mode),
    RELEASE_VERSION: shellQuote(input.release.version),
    AGENT_VERSION: shellQuote(input.release.version),
    SING_BOX_VERSION: shellQuote(input.release.singBox.version),
    AGENT_URL_AMD64: shellQuote(amd64.url),
    AGENT_SHA256_AMD64: shellQuote(amd64.sha256),
    SING_BOX_URL_AMD64: shellQuote(singBoxAmd64.url),
    SING_BOX_SHA256_AMD64: shellQuote(singBoxAmd64.sha256),
    AGENT_URL_ARM64: shellQuote(arm64.url),
    AGENT_SHA256_ARM64: shellQuote(arm64.sha256),
    SING_BOX_URL_ARM64: shellQuote(singBoxArm64.url),
    SING_BOX_SHA256_ARM64: shellQuote(singBoxArm64.sha256),
    ENROLLMENT_GRANT_LINE:
      input.enrollmentGrant === undefined
        ? "enrollment_grant="
        : `enrollment_grant=${shellQuote(input.enrollmentGrant)}`,
    PTY_FLAG: input.capabilities.some(
      (capability) => capability === "pty-v2" || capability === "pty-v1",
    )
      ? " --pty-enabled"
      : "",
  };

  let script = template;
  for (const [key, value] of Object.entries(values)) {
    script = script.replaceAll(`@@${key}@@`, value);
  }

  if (script.includes("@@")) {
    throw new Error("The installer template has an unresolved placeholder");
  }
  return script;
}
