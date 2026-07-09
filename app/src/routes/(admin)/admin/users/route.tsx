import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

import { AssignPlanDialog } from "./_modules/assign-plan-dialog";
import { BanUserDialog } from "./_modules/ban-user-dialog";
import { CredentialDialog } from "./_modules/credential-dialog";
import { EditSubscriptionDialog } from "./_modules/edit-subscription-dialog";

export const Route = createFileRoute("/(admin)/admin/users")({
  staticData: {
    crumb: () => m.admin_nav_users(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <Outlet />

      {/* Imperative dialog hosts — mounted once for the users section. */}
      <BanUserDialog />
      <AssignPlanDialog />
      <CredentialDialog />
      <EditSubscriptionDialog />
    </>
  );
}
