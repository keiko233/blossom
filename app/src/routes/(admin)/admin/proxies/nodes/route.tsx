import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/proxies/nodes")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_nodes(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
