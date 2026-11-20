import { createFileRoute, useParams } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { NodeFormPage } from "./_modules/node-form-page";

export const Route = createFileRoute(
  "/(admin)/admin/servers/$serverId/inbounds/new",
)({
  staticData: {
    crumb: () => m.admin_proxies_nodes_form_create_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const { serverId } = useParams({
    from: "/(admin)/admin/servers/$serverId/inbounds/new",
  });
  return <NodeFormPage requestedServerId={serverId} />;
}
