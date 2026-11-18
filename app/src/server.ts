import handler from "@tanstack/react-start/server-entry";

import { paraglideMiddleware } from "@/paraglide/server";

export { AgentSessionDO } from "@/durable-objects/agent-session";

function shouldBypassParaglide(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return true;
  }
  return new URL(request.url).pathname === "/api/agent/ws";
}

export default {
  fetch: (...args: Parameters<typeof handler.fetch>) =>
    shouldBypassParaglide(args[0])
      ? handler.fetch(...args)
      : paraglideMiddleware(args[0], () => handler.fetch(...args)),
};
