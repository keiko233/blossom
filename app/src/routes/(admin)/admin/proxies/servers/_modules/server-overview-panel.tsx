import type React from "react";

import { TrafficTrend } from "@/components/traffic-trend";
import { Badge } from "@/components/ui/badge";
import { serverWorkspaceStatus } from "@/lib/server-workspace";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { ServerHistoryPanel } from "./server-history-panel";
import { ServerLivePanel } from "./server-live-panel";
import { updateStateLabel } from "./server-status";

export interface ServerOverviewPanelProps {
  server: ServerDTO;
}

/** Overview tab: versions and update state, live telemetry, and traffic. */
export function ServerOverviewPanel({
  server,
}: ServerOverviewPanelProps): React.ReactElement {
  const status = serverWorkspaceStatus(server);
  const showLastError =
    Boolean(server.lastErrorMessage) &&
    ["degraded", "config_error", "runtime_error"].includes(status);

  return (
    <div data-slot="server-overview" className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
        <div>
          <h2 className="font-medium">
            {m.admin_proxies_servers_overview_title()}
          </h2>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_status_note()}
          </p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <VersionItem
            label={m.admin_proxies_servers_versions_agent()}
            version={server.agentVersion}
            desired={server.desiredAgentVersion}
            state={server.agentUpdateState}
            error={server.agentUpdateError}
          />
          <VersionItem
            label={m.admin_proxies_servers_versions_sing_box()}
            version={server.singBoxVersion}
            desired={server.desiredSingBoxVersion}
            state={server.singBoxUpdateState}
            error={server.singBoxUpdateError}
          />
        </dl>
        {showLastError ? (
          <p className="text-sm text-destructive">{server.lastErrorMessage}</p>
        ) : null}
      </section>

      <ServerLivePanel serverId={server.id} />
      <ServerHistoryPanel serverId={server.id} />
      <TrafficTrend serverId={server.id} />
    </div>
  );
}

interface VersionItemProps {
  label: string;
  version: string | null;
  desired: string | null;
  state: string;
  error: string | null;
}

function VersionItem({
  label,
  version,
  desired,
  state,
  error,
}: VersionItemProps): React.ReactElement {
  const stateText = updateStateLabel(state);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono">{version ? `v${version}` : "—"}</span>
        {desired ? (
          <span className="font-mono text-muted-foreground">→ {desired}</span>
        ) : null}
        {stateText ? (
          <Badge variant="outline" title={error ?? undefined}>
            {stateText}
          </Badge>
        ) : null}
      </dd>
      {state === "failed" && error ? (
        <dd className="text-xs text-destructive">{error}</dd>
      ) : null}
    </div>
  );
}
