import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSession } from "@/lib/auth";

import { AdminSidebar } from "./_modules/admin-sidebar";
import { AdminHeader, AutoBreadcrumb } from "./_modules/header";

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
  return (
    <SidebarProvider>
      <AdminSidebar />

      <SidebarInset>
        <AdminHeader>
          <AutoBreadcrumb />
        </AdminHeader>

        <main className="">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
