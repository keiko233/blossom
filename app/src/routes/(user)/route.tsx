import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AutoBreadcrumb } from "@/components/app-shell/auto-breadcrumb";
import { AppShellHeader } from "@/components/app-shell/header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSession } from "@/lib/auth";

import { UserSidebar } from "./_modules/user-sidebar";

export const Route = createFileRoute("/(user)")({
  beforeLoad: async () => {
    const session = await getSession();

    if (!session) {
      throw redirect({
        to: "/auth/login",
      });
    }

    return {
      user: session.user,
    };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { user } = Route.useRouteContext();

  return (
    <SidebarProvider>
      <UserSidebar user={user} />

      <SidebarInset>
        <AppShellHeader>
          <AutoBreadcrumb />
        </AppShellHeader>

        <main className="">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
