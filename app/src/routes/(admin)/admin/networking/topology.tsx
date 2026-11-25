import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import type React from "react";

import { WorkbenchSkeleton } from "@/components/app-shell/skeletons";
import { WorkbenchViewport } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { m } from "@/paraglide/messages";

import { TopologyWorkbench } from "./_modules/topology-workbench";
import { useNetworkingWorkspace } from "./_modules/use-networking-workspace";

export const Route = createFileRoute("/(admin)/admin/networking/topology")({
  staticData: {
    crumb: () => m.admin_workspace_networking_topology(),
  },
  component: RouteComponent,
});

function TopologyLoadError({
  onRetry,
}: {
  onRetry: () => void;
}): React.ReactElement {
  return (
    <Empty className="flex-1" data-slot="topology-load-error">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{m.admin_ui_load_error()}</EmptyTitle>
        <EmptyDescription>{m.admin_networking_load_error()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={onRetry}>
          {m.admin_networking_action_retry()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function RouteComponent(): React.ReactElement {
  const { data, isPending, isError, refetch } = useNetworkingWorkspace();

  if (isPending) {
    return (
      <WorkbenchSkeleton
        className="min-h-0 flex-1"
        data-slot="topology-workbench"
        variant="topology"
      />
    );
  }

  return (
    <WorkbenchViewport data-slot="topology-workbench">
      {isError || !data ? (
        <TopologyLoadError onRetry={() => void refetch()} />
      ) : (
        <TopologyWorkbench data={data} />
      )}
    </WorkbenchViewport>
  );
}
