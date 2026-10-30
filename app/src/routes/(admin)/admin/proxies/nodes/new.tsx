import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { serverContextSearchSchema } from "@/lib/server-node-context";
import { m } from "@/paraglide/messages";

import { NodeFormPage } from "./_modules/node-form-page";

export const Route = createFileRoute("/(admin)/admin/proxies/nodes/new")({
  validateSearch: serverContextSearchSchema,
  staticData: {
    crumb: () => m.admin_proxies_nodes_form_create_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const { serverId } = Route.useSearch();
  return <NodeFormPage requestedServerId={serverId} />;
}
