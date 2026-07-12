import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/proxies/servers")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_servers(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
