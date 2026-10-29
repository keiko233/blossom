import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

import { CredentialDialog } from "../users/_modules/credential-dialog";
import { EditSubscriptionDialog } from "../users/_modules/edit-subscription-dialog";
import { SubscriptionLinkDialog } from "../users/_modules/subscription-link-dialog";
import { BulkActionDialog } from "./_modules/bulk-action-dialog";

export const Route = createFileRoute("/(admin)/admin/subscriptions")({
  staticData: {
    crumb: () => m.admin_nav_subscriptions(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <Outlet />

      {/* Imperative dialog hosts — mounted once for the subscriptions section. */}
      <BulkActionDialog />
      <CredentialDialog />
      <EditSubscriptionDialog />
      <SubscriptionLinkDialog />
    </>
  );
}
