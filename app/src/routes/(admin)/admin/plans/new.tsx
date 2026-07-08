import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { PlanFormPage } from "./_modules/plan-form-page";

export const Route = createFileRoute("/(admin)/admin/plans/new")({
  staticData: {
    crumb: () => m.admin_plans_form_create_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return <PlanFormPage />;
}
