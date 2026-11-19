import { z } from "zod";

/**
 * Approved server-agent release manifests used by the system installer.
 *
 * The installer is rendered from control-plane data, not from a GitHub release
 * response. A downloaded mirror can therefore replace bytes but cannot replace
 * the expected SHA-256. Only manifests compiled into the control plane are
 * approved; the default catalog is empty until a compatible release is
 * reviewed.
 */

export const AGENT_INSTALLER_CONTRACT_VERSION = 1;

/**
 * Capabilities an approved release must advertise before the installer may
 * issue a grant. `oauth-ws-v1` belongs to the WebSocket companion; requiring it
 * here keeps this route from installing an agent that cannot use the identity.
 */
export const AGENT_INSTALLER_REQUIRED_CAPABILITIES = [
  "credentials-file-v1",
  "oauth-enrollment-cli-v1",
  "oauth-ws-v1",
] as const;

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const versionSchema = z.string().regex(SEMVER_PATTERN, "Invalid version");
const sha256Schema = z.string().regex(SHA256_PATTERN, "Invalid SHA-256");
const httpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  const authority = url.href
    .slice(url.protocol.length + 2)
    .split(/[/?#]/, 1)[0];
  return (
    url.protocol === "https:" &&
    authority === url.host &&
    url.search === "" &&
    url.hash === ""
  );
}, "Release URLs must be HTTPS without credentials or fragments");

const assetSchema = z
  .object({
    url: httpsUrlSchema,
    sha256: sha256Schema,
  })
  .strict();

const architectureAssetsSchema = z
  .object({
    amd64: assetSchema,
    arm64: assetSchema,
  })
  .strict();

const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: versionSchema,
    tag: z
      .string()
      .regex(
        /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
      ),
    installerContract: z.literal(AGENT_INSTALLER_CONTRACT_VERSION),
    agent: z
      .object({
        capabilities: z
          .array(z.string().regex(CAPABILITY_PATTERN))
          .max(64)
          .default([]),
        assets: architectureAssetsSchema,
      })
      .strict(),
    singBox: z
      .object({
        version: versionSchema,
        assets: architectureAssetsSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.tag !== `v${manifest.version}`) {
      ctx.addIssue({
        code: "custom",
        path: ["tag"],
        message: "The release tag must match the manifest version",
      });
    }
  });

export type AgentReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type AgentReleaseAsset =
  AgentReleaseManifest["agent"]["assets"]["amd64"];
export type AgentInstallerArchitecture =
  keyof AgentReleaseManifest["agent"]["assets"];

export type InstallerReleaseErrorCode =
  | "no_approved_release"
  | "release_not_approved"
  | "release_incompatible";

export class InstallerReleaseError extends Error {
  constructor(
    readonly code: InstallerReleaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InstallerReleaseError";
  }
}

/** Parses and validates the complete approved catalog. Duplicates are rejected. */
export function parseApprovedAgentReleases(
  input: readonly unknown[],
): AgentReleaseManifest[] {
  const releases = input.map((manifest) =>
    releaseManifestSchema.parse(manifest),
  );
  const versions = new Set<string>();
  for (const release of releases) {
    if (versions.has(release.version)) {
      throw new Error(`Duplicate approved agent release ${release.version}`);
    }
    versions.add(release.version);
  }
  return releases;
}

export function isAgentReleaseCompatible(
  release: AgentReleaseManifest,
): boolean {
  return AGENT_INSTALLER_REQUIRED_CAPABILITIES.every((capability) =>
    release.agent.capabilities.includes(capability),
  );
}

function normalizeRequestedVersion(requested: string): string {
  return requested
    .trim()
    .replace(/^server-agent-v/, "")
    .replace(/^v/, "");
}

/**
 * Resolves the requested version, or the first (newest) compatible manifest
 * when no version is requested. The catalog order is the approval order.
 */
export function selectApprovedAgentRelease(
  releases: readonly AgentReleaseManifest[],
  requested: string | null,
): AgentReleaseManifest {
  if (requested === null || requested.trim() === "" || requested === "latest") {
    const release = releases.find(isAgentReleaseCompatible);
    if (!release) {
      throw new InstallerReleaseError(
        "no_approved_release",
        "No compatible approved server-agent release is configured",
      );
    }
    return release;
  }

  const version = normalizeRequestedVersion(requested);
  const release = releases.find((candidate) => candidate.version === version);
  if (!release) {
    throw new InstallerReleaseError(
      "release_not_approved",
      `Server-agent release ${version} is not approved for installation`,
    );
  }
  if (!isAgentReleaseCompatible(release)) {
    throw new InstallerReleaseError(
      "release_incompatible",
      `Server-agent release ${version} lacks the capabilities required by this installer`,
    );
  }
  return release;
}
