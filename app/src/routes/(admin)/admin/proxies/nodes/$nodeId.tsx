import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";
import { getNode } from "@/query/nodes";

import { NodeFormPage } from "./_modules/node-form-page";

export const Route = createFileRoute("/(admin)/admin/proxies/nodes/$nodeId")({
  loader: ({ params }) => getNode({ data: { id: params.nodeId } }),
  staticData: {
    crumb: () => m.admin_proxies_nodes_form_edit_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const node = Route.useLoaderData();
  // Remount when navigating between nodes so the form re-initialises cleanly.
  return <NodeFormPage key={node.id} node={node} />;
}
