import type { Server } from "@/db/proxy-schema";
import { hashAgentToken } from "@/lib/agent-token";
import { findAgentServerByTokenHash } from "@/query/agent";

export interface StaticAgentAuthentication {
  server: Server;
  /** SHA-256 of the bearer token that authenticated the request. */
  tokenHash: string;
}

/**
 * The one static-token lookup shared by agent HTTP and both WebSocket
 * subprotocols. A missing hash column (OAuth-only server or disabled backup
 * credential) therefore fails every surface. HTTP keeps accepting disabled
 * servers so they can pull the empty config that tears the proxy down; the
 * WebSocket upgrade requires an enabled server.
 */
export async function authenticateStaticAgentToken(
  token: string,
  options: { allowDisabled: boolean },
  lookup: (
    tokenHash: string,
  ) => Promise<Server | null> = findAgentServerByTokenHash,
): Promise<StaticAgentAuthentication | null> {
  const tokenHash = hashAgentToken(token);
  const server = await lookup(tokenHash);
  if (!server || (!options.allowDisabled && !server.enabled)) {
    return null;
  }
  return { server, tokenHash };
}
