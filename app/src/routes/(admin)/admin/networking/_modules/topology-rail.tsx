import type React from "react";

import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import type {
  TopologyList,
  TopologySelection,
} from "@/lib/networking-topology";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { NetworkingWorkspaceData } from "@/query/networking-read";

import { NetworkingRollouts } from "./networking-rollouts";
import { TopologyInspector } from "./topology-inspector";

export type TopologyRailTab = "inspector" | "rollouts";

export interface TopologyRailProps {
  selection: TopologySelection | null;
  list: TopologyList;
  workspace: NetworkingWorkspaceData;
  tab: TopologyRailTab;
  onTabChange: (tab: TopologyRailTab) => void;
  className?: string;
}

/**
 * Rail content for one tab set. The caller decides where it lives: the
 * docked `WorkbenchRail` from `lg`, or a `Sheet` below it. Only the selected
 * panel scrolls, so the rail never nests scrollers.
 */
export function TopologyRailContent({
  selection,
  list,
  workspace,
  tab,
  onTabChange,
  className,
}: TopologyRailProps): React.ReactElement {
  return (
    <Tabs
      className={cn("min-h-0 flex-1 gap-0", className)}
      value={tab}
      onValueChange={(value) =>
        onTabChange(value === "rollouts" ? "rollouts" : "inspector")
      }
    >
      <TabsList
        variant="underline"
        className="h-10 w-full shrink-0 items-stretch border-b px-2"
      >
        <TabsTab value="inspector">
          {m.admin_networking_topology_wb_tab_inspector()}
        </TabsTab>
        <TabsTab value="rollouts">
          {m.admin_networking_topology_wb_tab_rollouts()}
        </TabsTab>
      </TabsList>
      <TabsPanel
        className="min-h-0 overflow-y-auto p-4"
        value="inspector"
        data-slot="topology-rail-inspector"
      >
        <TopologyInspector
          selection={selection}
          list={list}
          workspace={workspace}
        />
      </TabsPanel>
      <TabsPanel
        className="min-h-0 overflow-y-auto p-4"
        value="rollouts"
        data-slot="topology-rail-rollouts"
      >
        <NetworkingRollouts
          rollouts={workspace.rollouts}
          activationEnabled={workspace.activationEnabled}
        />
      </TabsPanel>
    </Tabs>
  );
}
