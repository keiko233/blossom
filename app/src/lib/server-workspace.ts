import {
  type AgentStatusLike,
  deriveServerHealth,
  type ServerHealth,
} from "@blossom/domain/agent-status";

/**
 * Pure helpers for the server workspace sidebar: the status a server shows
 * there, the search filter, and the arrow-key rule for moving through the list.
 * Kept out of the components so each rule is unit-testable.
 */

/**
 * `awaiting_installation` is a server whose agent has never reported a
 * heartbeat. Every other value is the agent-health verdict.
 */
export type ServerWorkspaceStatus = ServerHealth | "awaiting_installation";

/**
 * A server with no heartbeat has never been installed, so "offline" would
 * mislead. Disabled still wins because it is an explicit operator decision.
 */
export function serverWorkspaceStatus(
  server: AgentStatusLike,
  now = Date.now(),
): ServerWorkspaceStatus {
  if (!server.enabled) {
    return "disabled";
  }
  if (!server.lastSeenAt) {
    return "awaiting_installation";
  }
  return deriveServerHealth(server, now);
}

/**
 * Case-insensitive substring match on name, address and remark. A blank query
 * keeps every server in its original order.
 */
export function filterServersByQuery<
  T extends { name: string; address: string; remark?: string | null },
>(servers: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...servers];
  }
  return servers.filter((server) =>
    [server.name, server.address, server.remark ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Index the sidebar should focus after an arrow, Home or End key, or `null`
 * when the key is not a list-navigation key. `current` is -1 when nothing in
 * the list has focus yet; ArrowDown then enters at the top and ArrowUp at the
 * bottom. Movement clamps at both ends rather than wrapping.
 */
export function nextServerListIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, count - 1);
    case "ArrowUp":
      return current < 0 ? count - 1 : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
