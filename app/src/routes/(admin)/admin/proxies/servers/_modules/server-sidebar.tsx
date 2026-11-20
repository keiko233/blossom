import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";

import { WorkspaceSidebar } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  filterServersByQuery,
  nextServerListIndex,
} from "@/lib/server-workspace";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { ServerListItem } from "@/query/servers";

import { ServerStatusBadge } from "./server-status";

export interface ServerSidebarProps {
  id: string;
  className?: string;
  servers: ServerListItem[] | undefined;
  isPending: boolean;
  isError: boolean;
  /** Runs after a choice is made, so a narrow layout can close the list. */
  onNavigate: () => void;
}

/**
 * Searchable list of servers beside the workspace. Arrow keys move focus
 * through the visible rows (ArrowDown from the search field enters the list),
 * and the selected server is marked by the router's `aria-current`.
 */
export function ServerSidebar({
  id,
  className,
  servers,
  isPending,
  isError,
  onNavigate,
}: ServerSidebarProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const navRef = useRef<HTMLElement>(null);
  const visible = servers ? filterServersByQuery(servers, query) : [];

  const rowLinks = () =>
    Array.from(
      navRef.current?.querySelectorAll<HTMLAnchorElement>(
        "a[data-server-link]",
      ) ?? [],
    );

  const moveFocus = (current: number, key: string): boolean => {
    const links = rowLinks();
    const next = nextServerListIndex(key, current, links.length);
    if (next === null) {
      return false;
    }
    links[next]?.focus();
    return true;
  };

  // Only ArrowDown leaves the field; Home and End keep moving the text caret.
  const handleSearchKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "ArrowDown" && moveFocus(-1, event.key)) {
      event.preventDefault();
    }
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const current = rowLinks().indexOf(event.target as HTMLAnchorElement);
    if (moveFocus(current, event.key)) {
      event.preventDefault();
    }
  };

  return (
    <WorkspaceSidebar
      id={id}
      data-slot="server-sidebar"
      className={cn("gap-3 p-4", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">{m.admin_nav_proxies_item_servers()}</h2>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/admin/proxies/servers/new" onClick={onNavigate} />}
        >
          <PlusIcon />
          {m.admin_proxies_servers_add()}
        </Button>
      </div>

      <Input
        type="search"
        size="sm"
        aria-label={m.admin_proxies_servers_sidebar_search_label()}
        placeholder={m.admin_proxies_servers_sidebar_search_placeholder()}
        value={query}
        onValueChange={(value) => setQuery(value)}
        onKeyDown={handleSearchKeyDown}
      />

      {isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {m.admin_proxies_servers_sidebar_list_error()}
        </p>
      ) : !servers || servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_proxies_servers_empty_title()}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_proxies_servers_sidebar_no_matches({ query: query.trim() })}
        </p>
      ) : (
        <nav
          ref={navRef}
          aria-label={m.admin_proxies_servers_sidebar_list_label()}
          onKeyDown={handleListKeyDown}
        >
          <ul className="flex flex-col gap-1">
            {visible.map((server) => (
              <li key={server.id}>
                <Link
                  to="/admin/proxies/servers/$serverId"
                  params={{ serverId: server.id }}
                  data-server-link
                  onClick={onNavigate}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg px-2.5 py-2 outline-none",
                    "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/24",
                    "aria-[current=page]:bg-accent",
                  )}
                >
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {server.name}
                    </span>
                    <ServerStatusBadge server={server} />
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {server.address}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </WorkspaceSidebar>
  );
}
