import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/(admin)/admin/proxies")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}
