import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

import { CodesRevealDialog } from "./_modules/codes-reveal-dialog";

export const Route = createFileRoute("/(admin)/admin/redeem")({
  staticData: {
    crumb: () => m.admin_nav_redeem(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <Outlet />

      {/* Imperative dialog host — mounted once for the redeem section. */}
      <CodesRevealDialog />
    </>
  );
}
