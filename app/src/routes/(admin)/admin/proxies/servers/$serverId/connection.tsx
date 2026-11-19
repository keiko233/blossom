import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerConnectionPanel } from "../_modules/server-connection-panel";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/proxies/servers/$serverId/connection",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_connection(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return <ServerConnectionPanel server={server} />;
}
