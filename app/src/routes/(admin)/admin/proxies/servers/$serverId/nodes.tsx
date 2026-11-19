import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerNodesPanel } from "../_modules/server-nodes-panel";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/proxies/servers/$serverId/nodes",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_nodes(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return <ServerNodesPanel serverId={server.id} />;
}
