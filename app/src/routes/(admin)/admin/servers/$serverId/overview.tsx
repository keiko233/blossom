import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerOverviewPanel } from "../_modules/server-overview-panel";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/servers/$serverId/overview",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_overview(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return <ServerOverviewPanel server={server} />;
}
