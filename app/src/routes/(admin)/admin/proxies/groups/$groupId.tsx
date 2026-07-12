import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";
import { getGroup } from "@/query/groups";

import { GroupFormPage } from "./_modules/group-form-page";

export const Route = createFileRoute("/(admin)/admin/proxies/groups/$groupId")({
  loader: ({ params }) => getGroup({ data: { id: params.groupId } }),
  staticData: {
    crumb: () => m.admin_proxies_groups_form_edit_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const group = Route.useLoaderData();
  // Remount when navigating between groups so the form re-initialises cleanly.
  return <GroupFormPage key={group.id} group={group} />;
}
