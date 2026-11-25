import { Link } from "@tanstack/react-router";
import { cva } from "class-variance-authority";
import type React from "react";
import { useRef } from "react";

import { WorkspaceTabBar } from "@/components/app-shell/workspace";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { nextServerListIndex } from "@/lib/server-workspace";
import { m } from "@/paraglide/messages";
import type { ServerDTO, ServerListItem } from "@/query/servers";

import { ServerActionsMenu } from "./server-actions-menu";
import { ServerStatusPill } from "./server-status";

const serverTabVariants = cva([
  "relative inline-flex h-full shrink-0 items-center px-3 text-sm outline-none transition-colors",
  "text-muted-foreground hover:text-foreground",
  "focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:ring-inset",
  "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent",
  "aria-[current=page]:font-medium aria-[current=page]:text-foreground",
  "aria-[current=page]:after:bg-primary",
]);

export interface ServerTabBarProps {
  server: ServerDTO;
  /** The server's list row, present once the list has loaded. */
  item: ServerListItem | undefined;
}

interface TabDefinition {
  key: string;
  label: () => string;
  to:
    | "/admin/servers/$serverId/overview"
    | "/admin/servers/$serverId/live"
    | "/admin/servers/$serverId/inbounds"
    | "/admin/servers/$serverId/outbounds"
    | "/admin/servers/$serverId/logs"
    | "/admin/servers/$serverId/terminal"
    | "/admin/servers/$serverId/connection"
    | "/admin/servers/$serverId/settings";
}

const TAB_GROUPS: readonly (readonly TabDefinition[])[] = [
  [
    {
      key: "overview",
      label: m.admin_proxies_servers_workspace_tab_overview,
      to: "/admin/servers/$serverId/overview",
    },
    {
      key: "live",
      label: m.admin_server_ws_tab_live,
      to: "/admin/servers/$serverId/live",
    },
  ],
  [
    {
      key: "inbounds",
      label: m.admin_proxies_servers_workspace_tab_inbounds,
      to: "/admin/servers/$serverId/inbounds",
    },
    {
      key: "outbounds",
      label: m.admin_proxies_servers_workspace_tab_outbounds,
      to: "/admin/servers/$serverId/outbounds",
    },
  ],
  [
    {
      key: "logs",
      label: m.admin_proxies_servers_workspace_tab_logs,
      to: "/admin/servers/$serverId/logs",
    },
    {
      key: "terminal",
      label: m.admin_proxies_servers_workspace_tab_terminal,
      to: "/admin/servers/$serverId/terminal",
    },
  ],
  [
    {
      key: "connection",
      label: m.admin_proxies_servers_workspace_tab_connection,
      to: "/admin/servers/$serverId/connection",
    },
    {
      key: "settings",
      label: m.admin_proxies_servers_workspace_tab_settings,
      to: "/admin/servers/$serverId/settings",
    },
  ],
];

/** Tabs move horizontally; the shared list helper navigates vertically. */
const horizontalKey: Record<string, string> = {
  ArrowLeft: "ArrowUp",
  ArrowRight: "ArrowDown",
};

export function ServerTabBar({
  server,
  item,
}: ServerTabBarProps): React.ReactElement {
  const navRef = useRef<HTMLElement>(null);

  const tabLinks = () =>
    Array.from(
      navRef.current?.querySelectorAll<HTMLAnchorElement>(
        "a[data-server-tab]",
      ) ?? [],
    );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const links = tabLinks();
    const current = links.indexOf(event.target as HTMLAnchorElement);
    const next = nextServerListIndex(
      horizontalKey[event.key] ?? event.key,
      current,
      links.length,
    );
    if (next === null) {
      return;
    }
    event.preventDefault();
    links[next]?.focus();
  };

  return (
    <WorkspaceTabBar data-slot="server-tab-bar" className="gap-0 px-2">
      <nav
        ref={navRef}
        aria-label={m.admin_proxies_servers_workspace_tabs_label()}
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
        onKeyDown={handleKeyDown}
      >
        {TAB_GROUPS.map((group, groupIndex) => (
          <div className="flex items-stretch" key={group[0]?.key ?? groupIndex}>
            {groupIndex > 0 && (
              <Separator
                aria-hidden="true"
                className="my-auto h-4"
                orientation="vertical"
              />
            )}
            {group.map((tab) => (
              <Link
                key={tab.key}
                to={tab.to}
                params={{ serverId: server.id }}
                data-server-tab
                className={serverTabVariants()}
              >
                {tab.label()}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="ms-auto flex shrink-0 items-center gap-2 ps-2 pe-1">
        {item && item.pendingConfigChanges > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge size="sm" variant="warning" className="max-sm:hidden" />
              }
            >
              {m.admin_proxies_servers_pending_changes({
                count: item.pendingConfigChanges,
              })}
            </TooltipTrigger>
            <TooltipPopup>
              {m.admin_proxies_servers_pending_changes_help()}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <ServerStatusPill server={server} />
        {item ? (
          <ServerActionsMenu server={item} />
        ) : (
          <Skeleton className="size-7" />
        )}
      </div>
    </WorkspaceTabBar>
  );
}
