import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerSettingsPanel } from "../_modules/server-settings-panel";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/proxies/servers/$serverId/settings",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_settings(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return <ServerSettingsPanel server={server} />;
}
