import { createFileRoute, Outlet } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { AdminWorkspaceFrame } from "../../_modules/admin-workspace-frame";
import { operationsSections } from "../../_modules/admin-workspace-sections";

export const Route = createFileRoute("/(admin)/admin/operations")({
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return (
    <AdminWorkspaceFrame
      title={m.admin_workspace_operations()}
      sections={operationsSections()}
    >
      <Outlet />
    </AdminWorkspaceFrame>
  );
}
