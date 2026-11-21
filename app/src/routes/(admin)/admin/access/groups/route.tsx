import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/access/groups")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_groups(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
