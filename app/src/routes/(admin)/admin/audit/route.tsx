import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

import { PurgeAuditDialog } from "./_modules/purge-audit-dialog";

export const Route = createFileRoute("/(admin)/admin/audit")({
  staticData: {
    crumb: () => m.admin_audit_nav(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <Outlet />

      {/* Imperative dialog host — mounted once for the audit section. */}
      <PurgeAuditDialog />
    </>
  );
}
