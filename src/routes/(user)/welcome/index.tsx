import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/(user)/welcome/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/(user)/welcome/"!</div>;
}
