import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import type React from "react";
import { useState } from "react";

import { Workspace, WorkspacePane } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { serverWorkspaceStatus } from "@/lib/server-workspace";
import { m } from "@/paraglide/messages";

import { ServerSidebar } from "./_modules/server-sidebar";
import { statusDotTone } from "./_modules/server-status";
import { useServerList } from "./_modules/use-server-list";

const SIDEBAR_ID = "server-sidebar";

export const Route = createFileRoute("/(admin)/admin/servers")({
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
  const { serverId } = useParams({ strict: false });
  const selected = serverId
    ? servers?.find((server) => server.id === serverId)
    : undefined;
  const selectedStatus = selected ? serverWorkspaceStatus(selected) : null;

  return (
    <Workspace>
      <div className="flex items-center gap-2 border-b p-3 md:hidden">
        <Button
          variant="outline"
          size="sm"
          aria-expanded={listOpen}
          aria-controls={SIDEBAR_ID}
          onClick={() => setListOpen((open) => !open)}
        >
          {m.admin_nav_proxies_item_servers()}
        </Button>
        {selected ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="min-w-0 truncate text-sm font-medium">
              {selected.name}
            </span>
            {selectedStatus ? (
              <StatusDot
                label={m.admin_server_ws_mobile_status()}
                tone={statusDotTone[selectedStatus]}
              />
            ) : null}
          </>
        ) : null}
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
