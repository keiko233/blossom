import { createRouterClient } from "@orpc/server";
import type { RouterClient } from "@orpc/server";

import mcpRouter from "./router";

export { type MCPContext, READ_SCOPE, WRITE_SCOPE } from "./context";

export type MCPRouterClient = RouterClient<typeof mcpRouter>;

export { mcpRouter };

export interface MCPClientContext {
  actorUserId: string;
  scopes: string[];
  source: "external";
}

export function createMCPClient(context: MCPClientContext): MCPRouterClient {
  return createRouterClient(mcpRouter, {
    context: () => context,
  });
}
