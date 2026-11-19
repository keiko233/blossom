import type { AgentReleaseManifest } from "@/lib/agent-installer-release";

/**
 * Approved installer releases, newest first.
 *
 * Add an entry only after reviewing the published release's SHA-256 digests,
 * sing-box compatibility and the capabilities listed in
 * `AGENT_INSTALLER_REQUIRED_CAPABILITIES`. This catalog is deliberately empty:
 * without a compatible approved release, grant creation and script download
 * both refuse rather than installing an unverified or unusable agent.
 */
export const APPROVED_AGENT_RELEASES: readonly AgentReleaseManifest[] = [];
