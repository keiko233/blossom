import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/(admin)/_modules/nav-users")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/(admin)/_modules/nav-users"!</div>;
}
