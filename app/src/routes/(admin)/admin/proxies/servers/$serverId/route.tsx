import { createFileRoute, Outlet } from "@tanstack/react-router";
import type React from "react";

import { getServer } from "@/query/servers";

import { ServerWorkspaceHeader } from "../_modules/server-workspace-header";
import { ServerWorkspaceTabs } from "../_modules/server-workspace-tabs";
import { useServerList } from "../_modules/use-server-list";

export const Route = createFileRoute(
  "/(admin)/admin/proxies/servers/$serverId",
)({
  loader: ({ params }) => getServer({ data: { id: params.serverId } }),
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = Route.useLoaderData();
  const { data: servers } = useServerList();
  const item = servers?.find((row) => row.id === server.id);

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
      <ServerWorkspaceHeader server={server} item={item} />
      <ServerWorkspaceTabs serverId={server.id} />
      {/* Keyed by server so switching servers remounts the active tab and no
          state from the previous server carries over. */}
      <div key={server.id} className="flex min-w-0 flex-col gap-4">
        <Outlet />
      </div>
    </div>
  );
}
