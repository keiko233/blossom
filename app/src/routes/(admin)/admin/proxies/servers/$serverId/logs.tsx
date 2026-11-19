import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerLogsPanel } from "../_modules/server-logs-panel";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/proxies/servers/$serverId/logs",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_logs(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return <ServerLogsPanel server={server} />;
}
