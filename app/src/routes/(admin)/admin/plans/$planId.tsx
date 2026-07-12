import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";
import { getPlan } from "@/query/plans";

import { PlanFormPage } from "./_modules/plan-form-page";

export const Route = createFileRoute("/(admin)/admin/plans/$planId")({
  loader: ({ params }) => getPlan({ data: { id: params.planId } }),
  staticData: {
    crumb: () => m.admin_plans_form_edit_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const plan = Route.useLoaderData();
  // Remount when navigating between plans so the form re-initialises cleanly.
  return <PlanFormPage key={plan.id} plan={plan} />;
}
