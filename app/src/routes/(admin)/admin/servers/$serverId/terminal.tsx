import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { WorkbenchViewport } from "@/components/app-shell/workspace";
import { m } from "@/paraglide/messages";

import { AgentTerminalPanel } from "../_modules/agent-terminal-panel";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/servers/$serverId/terminal",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_terminal(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return (
    <WorkbenchViewport data-slot="terminal-workbench">
      <AgentTerminalPanel server={server} />
    </WorkbenchViewport>
  );
}
