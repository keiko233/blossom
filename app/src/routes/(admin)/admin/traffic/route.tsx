import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/traffic")({
  staticData: {
    crumb: () => m.admin_traffic_nav(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
