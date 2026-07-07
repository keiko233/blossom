import { os } from "@orpc/server";

export interface ORPCContext {
  headers: Headers | Record<string, string | undefined>;
}

/**
 * Base oRPC builder carrying the request headers. The only procedures mounted on
 * the public oRPC/OpenAPI surface are the agent endpoints (see `proxy/agent.ts`),
 * which authenticate with a per-node token. All admin operations live in server
 * functions (`@/lib/nodes`), not the API.
 */
export const base = os.$context<ORPCContext>();
