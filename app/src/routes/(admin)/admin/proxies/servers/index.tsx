import { createFileRoute, Link } from "@tanstack/react-router";
import { PlusIcon, ServerIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { m } from "@/paraglide/messages";

import { useServerList } from "./_modules/use-server-list";

export const Route = createFileRoute("/(admin)/admin/proxies/servers/")({
  component: RouteComponent,
});

/** Shown in the workspace when no server is selected. */
function RouteComponent(): React.ReactElement {
  const { data: servers } = useServerList();
  const noServers = servers?.length === 0;

  return (
    <div className="flex p-4 md:p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerIcon />
          </EmptyMedia>
          <EmptyTitle>
            {noServers
              ? m.admin_proxies_servers_empty_title()
              : m.admin_proxies_servers_select_title()}
          </EmptyTitle>
          {noServers ? null : (
            <EmptyDescription>
              {m.admin_proxies_servers_select_description()}
            </EmptyDescription>
          )}
        </EmptyHeader>
        <Button render={<Link to="/admin/proxies/servers/new" />}>
          <PlusIcon />
          {m.admin_proxies_servers_add()}
        </Button>
      </Empty>
    </div>
  );
}
