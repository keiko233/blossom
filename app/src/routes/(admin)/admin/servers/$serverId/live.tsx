import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerLiveTab } from "../_modules/server-live-tab";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute("/(admin)/admin/servers/$serverId/live")({
  staticData: {
    crumb: () => m.admin_server_ws_tab_live(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return <ServerLiveTab server={server} />;
}
