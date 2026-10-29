import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { TrafficTrend } from "@/components/traffic-trend";
import { m } from "@/paraglide/messages";
import { getServer } from "@/query/servers";

import { ServerFormPage } from "./_modules/server-form-page";

export const Route = createFileRoute(
  "/(admin)/admin/proxies/servers/$serverId",
)({
  loader: ({ params }) => getServer({ data: { id: params.serverId } }),
  staticData: {
    crumb: () => m.admin_proxies_servers_form_edit_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const server = Route.useLoaderData();
  // Remount when navigating between servers so the form re-initialises cleanly.
  return (
    <>
      <ServerFormPage key={server.id} server={server} />
      <div className="mx-auto w-full max-w-3xl px-4 pb-6">
        <TrafficTrend serverId={server.id} />
      </div>
    </>
  );
}
