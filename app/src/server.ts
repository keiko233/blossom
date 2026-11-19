import handler from "@tanstack/react-start/server-entry";

import { paraglideMiddleware } from "@/paraglide/server";
// Server functions enter a production build only through modules the server
// graph reaches. The log-policy admin API has no UI consumer yet, so import it
// here; the Logs tab will import it once it exists.
import "@/query/server-log-policy";

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
