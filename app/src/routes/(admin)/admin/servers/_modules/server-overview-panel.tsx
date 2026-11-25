import type React from "react";

import { PageContent } from "@/components/app-shell/page-header";
import { WorkspaceViewport } from "@/components/app-shell/workspace";
import { TrafficTrend } from "@/components/traffic-trend";
import type { ServerDTO, ServerListItem } from "@/query/servers";

import { ServerHistoryPanel } from "./server-history-panel";
import { ServerIdentitySection } from "./server-identity-section";
import { ServerVersionsSection } from "./server-versions-section";

export interface ServerOverviewPanelProps {
  server: ServerDTO;
  item: ServerListItem | undefined;
}

/**
 * Overview: a fast HTTP-only summary. The metrics WebSocket belongs to the
 * Live tab, so this route never renders a stream or its transport controls.
 */
export function ServerOverviewPanel({
  server,
  item,
}: ServerOverviewPanelProps): React.ReactElement {
  return (
    <WorkspaceViewport
      scrollId={`server-${server.id}-overview`}
      className="[--page-header-h:0px]"
    >
      <PageContent>
        <div
          data-slot="server-overview"
          className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] 3xl:grid-cols-[minmax(0,1fr)_26rem]"
        >
          <aside
            data-slot="server-overview-rail"
            className="flex flex-col gap-6 xl:order-last"
          >
            <ServerIdentitySection item={item} server={server} />
            <ServerVersionsSection server={server} />
          </aside>
          <div
            data-slot="server-overview-main"
            className="flex min-w-0 flex-col gap-6"
          >
            <ServerHistoryPanel serverId={server.id} />
            <TrafficTrend serverId={server.id} />
          </div>
        </div>
      </PageContent>
    </WorkspaceViewport>
  );
}
