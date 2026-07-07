import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin")({
  staticData: {
    crumb: () => m.admin_nav_dashboard(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
