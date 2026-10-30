import handler from "@tanstack/react-start/server-entry";

import { paraglideMiddleware } from "@/paraglide/server";

export default {
  fetch: (...args: Parameters<typeof handler.fetch>) =>
    paraglideMiddleware(args[0], () => handler.fetch(...args)),
};
