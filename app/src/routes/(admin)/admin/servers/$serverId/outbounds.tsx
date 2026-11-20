import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { m } from "@/paraglide/messages";

import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/servers/$serverId/outbounds",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_outbounds(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_servers_outbounds_title()}</PageHeaderTitle>
      </PageHeader>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.admin_servers_outbounds_empty_title()}</EmptyTitle>
          <EmptyDescription>
            {m.admin_servers_outbounds_empty_description({
              server: server.name,
            })}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
