import { createFileRoute, Outlet } from "@tanstack/react-router";
import type React from "react";
import { Fragment } from "react";

import { getServer } from "@/query/servers";

import { ServerTabBar } from "../_modules/server-tab-bar";
import { useServerList } from "../_modules/use-server-list";

export const Route = createFileRoute("/(admin)/admin/servers/$serverId")({
  loader: ({ params }) => getServer({ data: { id: params.serverId } }),
  staticData: {
    crumb: ({ loaderData }) =>
      typeof loaderData === "object" &&
      loaderData !== null &&
      "name" in loaderData &&
      typeof loaderData.name === "string"
        ? loaderData.name
        : null,
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = Route.useLoaderData();
  const { data: servers } = useServerList();
  const item = servers?.find((row) => row.id === server.id);

  return (
    <>
      <ServerTabBar server={server} item={item} />
      {/* Keyed so switching servers remounts the active tab and drops its
          state. Each tab owns its viewport and scroll restoration id. */}
      <Fragment key={server.id}>
        <Outlet />
      </Fragment>
    </>
  );
}
