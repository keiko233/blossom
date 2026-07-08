import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { GroupFormPage } from "./_modules/group-form-page";

export const Route = createFileRoute("/(admin)/admin/proxies/groups/new")({
  staticData: {
    crumb: () => m.admin_proxies_groups_form_create_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return <GroupFormPage />;
}
