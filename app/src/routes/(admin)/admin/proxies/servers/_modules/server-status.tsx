import type React from "react";

import { Badge } from "@/components/ui/badge";
import {
  serverWorkspaceStatus,
  type ServerWorkspaceStatus,
} from "@/lib/server-workspace";
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

const statusDotClass: Record<ServerWorkspaceStatus, string> = {
  online: "bg-emerald-500",
  degraded: "bg-amber-500",
  unknown: "bg-amber-500",
  agent_offline: "bg-red-500",
  runtime_error: "bg-red-500",
  config_error: "bg-red-500",
  disabled: "bg-muted-foreground/64",
  awaiting_installation: "bg-muted-foreground/64",
};

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
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${statusDotClass[status]}`}
      />
      {statusLabel[status]()}
    </Badge>
  );
}
