import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(user)/dashboard")({
  staticData: {
    crumb: () => m.user_dashboard_title(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
