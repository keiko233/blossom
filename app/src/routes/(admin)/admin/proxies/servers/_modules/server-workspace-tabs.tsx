import { Link } from "@tanstack/react-router";
import { cva } from "class-variance-authority";
import type React from "react";

import { m } from "@/paraglide/messages";

/**
 * Tab links are real routes, so each tab has a URL that survives reloads and
 * history. The active tab is styled from the `aria-current` the router sets.
 */
const serverTabVariants = cva([
  "-mb-px inline-flex shrink-0 items-center border-b-2 border-transparent px-3 py-2",
  "rounded-t-md text-sm text-muted-foreground outline-none transition-colors",
  "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/24",
  "aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground",
]);

export interface ServerWorkspaceTabsProps {
  serverId: string;
}

export function ServerWorkspaceTabs({
  serverId,
}: ServerWorkspaceTabsProps): React.ReactElement {
  return (
    <nav
      data-slot="server-workspace-tabs"
      aria-label={m.admin_proxies_servers_workspace_tabs_label()}
      className="flex gap-1 overflow-x-auto border-b"
    >
      {/* Overview is the index route, so it must match exactly to avoid
          staying active under every other tab. */}
      <Link
        to="/admin/proxies/servers/$serverId"
        params={{ serverId }}
        activeOptions={{ exact: true }}
        className={serverTabVariants()}
      >
        {m.admin_proxies_servers_workspace_tab_overview()}
      </Link>
      <Link
        to="/admin/proxies/servers/$serverId/nodes"
        params={{ serverId }}
        className={serverTabVariants()}
      >
        {m.admin_proxies_servers_workspace_tab_nodes()}
      </Link>
      <Link
        to="/admin/proxies/servers/$serverId/settings"
        params={{ serverId }}
        className={serverTabVariants()}
      >
        {m.admin_proxies_servers_workspace_tab_settings()}
      </Link>
      <Link
        to="/admin/proxies/servers/$serverId/terminal"
        params={{ serverId }}
        className={serverTabVariants()}
      >
        {m.admin_proxies_servers_workspace_tab_terminal()}
      </Link>
      <Link
        to="/admin/proxies/servers/$serverId/logs"
        params={{ serverId }}
        className={serverTabVariants()}
      >
        {m.admin_proxies_servers_workspace_tab_logs()}
      </Link>
    </nav>
  );
}
