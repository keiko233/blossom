import type React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { m } from "@/paraglide/messages";
import type { ServerDTO, ServerListItem } from "@/query/servers";

import { ServerActionsMenu } from "./server-actions-menu";
import { ServerStatusBadge } from "./server-status";

export interface ServerWorkspaceHeaderProps {
  server: ServerDTO;
  /** The server's list row, present once the list has loaded. */
  item: ServerListItem | undefined;
}

/**
 * Identity of the selected server above its tabs: name, status, address, and
 * the credential and lifecycle menu. The menu needs the list row for the node
 * count, so it appears only after the list has loaded.
 */
export function ServerWorkspaceHeader({
  server,
  item,
}: ServerWorkspaceHeaderProps): React.ReactElement {
  return (
    <PageHeader
      data-slot="server-workspace-header"
      className="flex-wrap items-start gap-3"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <PageHeaderTitle className="min-w-0 truncate">
            {server.name}
          </PageHeaderTitle>
          <ServerStatusBadge server={server} />
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {server.address}
          {server.remark ? ` · ${server.remark}` : ""}
        </p>
        {item && item.pendingConfigChanges > 0 ? (
          <p
            className="text-xs text-muted-foreground"
            title={m.admin_proxies_servers_pending_changes_help()}
          >
            {m.admin_proxies_servers_pending_changes({
              count: item.pendingConfigChanges,
            })}
          </p>
        ) : null}
      </div>
      {item ? <ServerActionsMenu server={item} /> : null}
    </PageHeader>
  );
}
