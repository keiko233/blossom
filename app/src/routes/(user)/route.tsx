import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AutoBreadcrumb } from "@/components/app-shell/auto-breadcrumb";
import { AppShellHeader } from "@/components/app-shell/header";
import { ImpersonationBanner } from "@/components/app-shell/impersonation-banner";
import { SiteNotices } from "@/components/app-shell/site-notices";
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
      // Set while an admin is viewing the app as this user.
      impersonatedBy: session.session.impersonatedBy ?? null,
    };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { user, impersonatedBy } = Route.useRouteContext();

  return (
    <SidebarProvider>
      <UserSidebar user={user} />

      <SidebarInset>
        <AppShellHeader>
          <AutoBreadcrumb />
        </AppShellHeader>

        <main className="">
          <SiteNotices />
          <Outlet />
        </main>
      </SidebarInset>

      {impersonatedBy ? <ImpersonationBanner user={user} /> : null}
    </SidebarProvider>
  );
}
