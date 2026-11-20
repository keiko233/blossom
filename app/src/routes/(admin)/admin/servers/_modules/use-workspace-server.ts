import { useLoaderData } from "@tanstack/react-router";

import type { ServerDTO } from "@/query/servers";

/**
 * The selected server, loaded by the `$serverId` layout. Tab routes read it
 * from there so each tab does not fetch the server again.
 */
export function useWorkspaceServer(): ServerDTO {
  return useLoaderData({ from: "/(admin)/admin/servers/$serverId" });
}
