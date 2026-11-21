import template from "@/lib/agent-bootstrap-template.sh?raw";

/**
 * Renders the public one-line installer from the fixed template. Only
 * validated values are substituted; the template never receives free text.
 * The enrollment grant is embedded because the install URL already carries it,
 * and the response that serves it is `private, no-store`.
 */

export const BOOTSTRAP_GRANT_PATTERN = /^egr_[A-Za-z0-9_-]{43}$/;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const AGENT_REPO = "keiko233/blossom";
const SING_BOX_REPO = "SagerNet/sing-box";
const IMAGE_REPOSITORY = "ghcr.io/keiko233/blossom/server-agent";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The public installer origin. HTTPS is required except for loopback, so local
 * development can fetch `http://localhost:3000/api/agent/install/<grant>.sh`.
 */
export function assertBootstrapOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("The installer origin is not a valid URL");
  }
  if (url.origin !== origin.replace(/\/$/, "")) {
    throw new Error("The installer origin must be a plain origin");
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!allowed) {
    throw new Error(
      "The installer origin must be HTTPS (HTTP is allowed only for loopback)",
    );
  }
  return url.origin;
}

/** `v1.5.0` and `1.5.0` both select the `1.5.0` image; anything else is refused. */
export function normalizeBootstrapVersion(version: string | null | undefined): {
  version: string;
  image: string;
} {
  const requested = version?.trim() ?? "";
  if (requested === "" || requested === "latest") {
    return { version: "latest", image: `${IMAGE_REPOSITORY}:latest` };
  }
  const bare = requested.replace(/^v/, "");
  if (!VERSION_PATTERN.test(bare)) {
    throw new Error("The agent version is malformed");
  }
  return { version: bare, image: `${IMAGE_REPOSITORY}:${bare}` };
}

export interface BootstrapScriptInput {
  /** Public control-plane origin, without a trailing slash. */
  publicOrigin: string;
  enrollmentGrant: string;
  /** Grant release, or `latest` when the grant did not pin one. */
  release: string | null;
}

export function renderAgentBootstrapScript(
  input: BootstrapScriptInput,
): string {
  const origin = assertBootstrapOrigin(input.publicOrigin);
  if (!BOOTSTRAP_GRANT_PATTERN.test(input.enrollmentGrant)) {
    throw new Error("The enrollment grant is malformed");
  }
  const { version, image } = normalizeBootstrapVersion(input.release);

  const values: Record<string, string> = {
    ORIGIN: shellQuote(origin),
    ENROLLMENT_GRANT: shellQuote(input.enrollmentGrant),
    AGENT_VERSION: shellQuote(version),
    IMAGE: shellQuote(image),
    AGENT_REPO: shellQuote(AGENT_REPO),
    SING_BOX_REPO: shellQuote(SING_BOX_REPO),
  };

  let script = template;
  for (const [key, value] of Object.entries(values)) {
    script = script.replaceAll(`@@${key}@@`, value);
  }
  if (script.includes("@@")) {
    throw new Error("The bootstrap template has an unresolved placeholder");
  }
  return script;
}

export interface BootstrapCommandsInput {
  publicOrigin: string;
  enrollmentGrant: string;
}

/** The two commands the admin UI shows for one onboarding grant. */
export function buildBootstrapCommands(input: BootstrapCommandsInput): {
  installUrl: string;
  dockerCommand: string;
  hostCommand: string;
} {
  const origin = assertBootstrapOrigin(input.publicOrigin);
  const installUrl = `${origin}/api/agent/install/${encodeURIComponent(input.enrollmentGrant)}.sh`;
  return {
    installUrl,
    dockerCommand: `curl -fsSL ${installUrl} | sh`,
    hostCommand: `curl -fsSL ${installUrl} | sh -s -- --host`,
  };
}
