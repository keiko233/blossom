import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/plans")({
  staticData: {
    crumb: () => m.admin_nav_plans(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
