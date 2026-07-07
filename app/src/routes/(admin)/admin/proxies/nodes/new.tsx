import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { NodeFormPage } from "./_modules/node-form-page";

export const Route = createFileRoute("/(admin)/admin/proxies/nodes/new")({
  staticData: {
    crumb: () => m.admin_proxies_nodes_form_create_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return <NodeFormPage />;
}
