import { createFileRoute, Outlet } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { AdminWorkspaceFrame } from "../../_modules/admin-workspace-frame";
import { accessSections } from "../../_modules/admin-workspace-sections";

export const Route = createFileRoute("/(admin)/admin/access")({
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return (
    <AdminWorkspaceFrame
      title={m.admin_workspace_access()}
      sections={accessSections()}
    >
      <Outlet />
    </AdminWorkspaceFrame>
  );
}
