import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { WorkspacePlaceholder } from "@/components/app-shell/workspace-placeholder";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/networking/links")({
  staticData: {
    crumb: () => m.admin_workspace_networking_links(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return (
    <WorkspacePlaceholder
      title={m.admin_workspace_networking_links()}
      description={m.admin_workspace_networking_placeholder()}
    />
  );
}
