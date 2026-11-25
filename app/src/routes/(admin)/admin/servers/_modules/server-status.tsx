import type React from "react";

import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import {
  serverWorkspaceStatus,
  type ServerWorkspaceStatus,
} from "@/lib/server-workspace";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

const statusLabel: Record<ServerWorkspaceStatus, () => string> = {
  online: m.admin_proxies_servers_status_online,
  agent_offline: m.admin_proxies_servers_status_offline,
  runtime_error: m.admin_proxies_servers_status_runtime_error,
  config_error: m.admin_proxies_servers_status_config_error,
  degraded: m.admin_proxies_servers_status_degraded,
  unknown: m.admin_proxies_servers_status_unknown,
  disabled: m.admin_proxies_servers_status_disabled,
  awaiting_installation: m.admin_proxies_servers_status_awaiting_installation,
};

export const statusDotTone: Record<
  ServerWorkspaceStatus,
  "success" | "warning" | "danger" | "muted"
> = {
  online: "success",
  degraded: "warning",
  unknown: "warning",
  agent_offline: "danger",
  runtime_error: "danger",
  config_error: "danger",
  disabled: "muted",
  awaiting_installation: "muted",
};

export function serverStatusContent(status: ServerWorkspaceStatus): {
  label: () => string;
  tone: "success" | "warning" | "danger" | "muted";
} {
  return { label: statusLabel[status], tone: statusDotTone[status] };
}

export function updateStateLabel(state: string): string | null {
  switch (state) {
    case "up_to_date":
      return m.admin_proxies_servers_update_up_to_date();
    case "checking":
    case "downloading":
    case "verifying":
    case "applying":
    case "restarting":
      return m.admin_proxies_servers_update_in_progress();
    case "failed":
      return m.admin_proxies_servers_update_failed();
    case "disabled":
      return m.admin_proxies_servers_update_disabled();
    default:
      return null;
  }
}

/**
 * Health of one server as a dot and label, used by the sidebar, the workspace
 * header and the overview. The raw agent error is a tooltip, not body text, so
 * the badge stays compact.
 */
export function ServerStatusBadge({
  server,
}: {
  server: ServerDTO;
}): React.ReactElement {
  const status = serverWorkspaceStatus(server);
  return (
    <Badge variant="outline" title={server.lastErrorMessage ?? undefined}>
      <StatusDot className="size-1.5" tone={statusDotTone[status]} />
      {statusLabel[status]()}
    </Badge>
  );
}

/**
 * Compact workspace header status: the dot stays visible at every width and
 * the label appears from `lg`. The full agent error stays a native tooltip.
 */
export function ServerStatusPill({
  server,
  className,
}: {
  server: ServerDTO;
  className?: string;
}): React.ReactElement {
  const status = serverWorkspaceStatus(server);
  const label = statusLabel[status]();
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      title={server.lastErrorMessage ?? label}
    >
      <StatusDot label={label} tone={statusDotTone[status]} />
      <span className="max-lg:sr-only">{label}</span>
    </span>
  );
}
