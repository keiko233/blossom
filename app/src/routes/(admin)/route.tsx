import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AutoBreadcrumb } from "@/components/app-shell/auto-breadcrumb";
import { AppShellHeader } from "@/components/app-shell/header";
import { Confirm } from "@/components/ui/confirm";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSession } from "@/lib/auth";

import { AdminSidebar } from "./_modules/admin-sidebar";
import { TokenRevealDialog } from "./admin/proxies/nodes/_modules/token-reveal-dialog";

export const Route = createFileRoute("/(admin)")({
  beforeLoad: async () => {
    const session = await getSession();

    if (!session) {
      throw redirect({
        to: "/auth/login",
      });
    }

    if (session.user.role !== "admin") {
      throw redirect({
        to: "/dashboard",
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
      <AdminSidebar user={user} />

      <SidebarInset>
        <AppShellHeader>
          <AutoBreadcrumb />
        </AppShellHeader>

        <main className="">
          <Outlet />
        </main>
      </SidebarInset>

      {/* Imperative dialog hosts — mounted once for the whole admin area. */}
      <Confirm />
      <TokenRevealDialog />
    </SidebarProvider>
  );
}
