import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/mcp")({
  staticData: {
    crumb: () => m.admin_nav_mcp(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
