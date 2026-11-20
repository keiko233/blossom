import { createFileRoute, Outlet } from "@tanstack/react-router";
import type React from "react";
import { useState } from "react";

import { Workspace, WorkspacePane } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

import { ServerSidebar } from "./_modules/server-sidebar";
import { useServerList } from "./_modules/use-server-list";

const SIDEBAR_ID = "server-sidebar";

export const Route = createFileRoute("/(admin)/admin/proxies/servers")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_servers(),
  },
  component: RouteComponent,
});

/**
 * Server workspace: a searchable server list beside the routed workspace. On
 * narrow screens the list starts closed behind a toggle, so the selected
 * server gets the full width.
 */
function RouteComponent(): React.ReactElement {
  const [listOpen, setListOpen] = useState(false);
  const { data: servers, isPending, isError } = useServerList();

  return (
    <Workspace>
      <div className="border-b p-3 md:hidden">
        <Button
          variant="outline"
          size="sm"
          aria-expanded={listOpen}
          aria-controls={SIDEBAR_ID}
          onClick={() => setListOpen((open) => !open)}
        >
          {m.admin_nav_proxies_item_servers()}
        </Button>
      </div>

      <ServerSidebar
        id={SIDEBAR_ID}
        className={listOpen ? "flex" : "hidden"}
        servers={servers}
        isPending={isPending}
        isError={isError}
        onNavigate={() => setListOpen(false)}
      />

      <WorkspacePane>
        <Outlet />
      </WorkspacePane>
    </Workspace>
  );
}
