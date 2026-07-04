import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/(auth)")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center"
      data-slot="auth-main"
    >
      <Outlet />
    </main>
  );
}
