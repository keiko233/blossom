import { z } from "zod";

/**
 * Pure helpers for moving between a server and its nodes: the validated
 * `serverId` search param shared by the node list and node create pages, the
 * rule that decides which server a new node starts on, and the node-list
 * filter. Kept out of the pages so the "never silently override an explicit
 * selection" rule is unit-testable.
 */

/**
 * Optional server context in the URL. An unusable value (non-string, empty,
 * oversized) is dropped instead of failing route validation, so a bad link
 * degrades to the page without context.
 */
export const serverContextSearchSchema = z.object({
  serverId: z.string().trim().min(1).max(128).optional().catch(undefined),
});

export type ServerContextSearch = z.infer<typeof serverContextSearchSchema>;

export type CreateServerNotice = "requested_missing" | null;

export interface CreateServerResolution {
  serverId: string;
  /** Set when the server named by the link cannot be used. */
  notice: CreateServerNotice;
}

/**
 * Chooses the server a new node starts on.
 *
 * - A server the admin already selected (`currentServerId`) always wins.
 * - A server named by the link is used when it still exists.
 * - A link to a server that was removed (or is not in the admin's list) selects
 *   nothing and reports it, so the admin must choose deliberately rather than
 *   having a different server picked for them.
 * - Without a link, the first server is the default (existing behaviour).
 */
export function resolveCreateServerId(input: {
  requestedServerId: string | undefined;
  currentServerId: string;
  servers: ReadonlyArray<{ id: string }>;
}): CreateServerResolution {
  const { requestedServerId, currentServerId, servers } = input;
  if (currentServerId) {
    return { serverId: currentServerId, notice: null };
  }
  if (requestedServerId) {
    return servers.some((server) => server.id === requestedServerId)
      ? { serverId: requestedServerId, notice: null }
      : { serverId: "", notice: "requested_missing" };
  }
  return { serverId: servers[0]?.id ?? "", notice: null };
}

/** Keeps only the nodes of one server; no filter returns everything. */
export function filterNodesByServer<T extends { serverId: string }>(
  nodes: readonly T[],
  serverId: string | undefined,
): T[] {
  return serverId
    ? nodes.filter((node) => node.serverId === serverId)
    : [...nodes];
}
