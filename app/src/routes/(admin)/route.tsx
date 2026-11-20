import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AutoBreadcrumb } from "@/components/app-shell/auto-breadcrumb";
import { AppShellHeader } from "@/components/app-shell/header";
import { ADMIN_VIEWPORT_SCROLL_ID } from "@/components/app-shell/workspace";
import { Confirm } from "@/components/ui/confirm";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSession } from "@/lib/auth";

import { AdminSidebar } from "./_modules/admin-sidebar";
import { TokenRevealDialog } from "./admin/proxies/servers/_modules/token-reveal-dialog";

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
    <SidebarProvider className="h-dvh">
      <AdminSidebar user={user} />

      {/* The shell fills the viewport and pages scroll inside the admin
          viewport, so workspaces can bound their own scroll regions. */}
      <SidebarInset className="min-h-0">
        <AppShellHeader>
          <AutoBreadcrumb />
        </AppShellHeader>

        <div
          data-slot="admin-viewport"
          data-scroll-restoration-id={ADMIN_VIEWPORT_SCROLL_ID}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <Outlet />
        </div>
      </SidebarInset>

      {/* Imperative dialog hosts — mounted once for the whole admin area. */}
      <Confirm />
      <TokenRevealDialog />
    </SidebarProvider>
  );
}
