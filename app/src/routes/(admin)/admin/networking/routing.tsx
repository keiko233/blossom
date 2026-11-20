import { createFileRoute, Link } from "@tanstack/react-router";
import type React from "react";

import { WorkspacePlaceholder } from "@/components/app-shell/workspace-placeholder";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/networking/routing")({
  staticData: {
    crumb: () => m.admin_workspace_networking_routing(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return (
    <WorkspacePlaceholder
      title={m.admin_workspace_networking_routing()}
      description={m.admin_workspace_networking_routing_placeholder()}
      actions={
        <Button
          variant="outline"
          render={<Link to="/admin/access/client-rules" />}
        >
          {m.admin_workspace_access_client_rules()}
        </Button>
      }
    />
  );
}
