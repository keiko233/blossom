import type React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { InstallationPhase } from "@/lib/agent-connection";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { ServerStatusBadge } from "./server-status";

const phaseLabel: Record<InstallationPhase, () => string> = {
  not_started: m.admin_proxies_servers_connection_phase_not_started,
  grant_ready: m.admin_proxies_servers_connection_phase_grant_ready,
  redeeming: m.admin_proxies_servers_connection_phase_redeeming,
  failed: m.admin_proxies_servers_connection_phase_failed,
  pending_activation:
    m.admin_proxies_servers_connection_phase_pending_activation,
  active: m.admin_proxies_servers_connection_phase_active,
  expired: m.admin_proxies_servers_connection_phase_expired,
  revoked: m.admin_proxies_servers_connection_phase_revoked,
};

const phaseDescription: Record<InstallationPhase, () => string> = {
  not_started: m.admin_proxies_servers_connection_phase_not_started_description,
  grant_ready: m.admin_proxies_servers_connection_phase_grant_ready_description,
  redeeming: m.admin_proxies_servers_connection_phase_redeeming_description,
  failed: m.admin_proxies_servers_connection_phase_failed_description,
  pending_activation:
    m.admin_proxies_servers_connection_phase_pending_activation_description,
  active: m.admin_proxies_servers_connection_phase_active_description,
  expired: m.admin_proxies_servers_connection_phase_expired_description,
  revoked: m.admin_proxies_servers_connection_phase_revoked_description,
};

const phaseTone: Record<
  InstallationPhase,
  "success" | "warning" | "error" | "outline"
> = {
  not_started: "outline",
  grant_ready: "warning",
  redeeming: "warning",
  failed: "error",
  pending_activation: "warning",
  active: "success",
  expired: "warning",
  revoked: "outline",
};

const runtimeLabel: Record<ServerDTO["runtimeState"], () => string> = {
  unknown: m.admin_proxies_servers_connection_runtime_unknown,
  starting: m.admin_proxies_servers_connection_runtime_starting,
  running: m.admin_proxies_servers_connection_runtime_running,
  stopped: m.admin_proxies_servers_connection_runtime_stopped,
  crash_loop: m.admin_proxies_servers_connection_runtime_crash_loop,
};

const configLabel: Record<ServerDTO["configState"], () => string> = {
  unknown: m.admin_proxies_servers_connection_config_unknown,
  applied: m.admin_proxies_servers_connection_config_applied,
  rejected: m.admin_proxies_servers_connection_config_rejected,
  apply_failed: m.admin_proxies_servers_connection_config_apply_failed,
};

export interface ServerConnectionSummaryProps {
  server: ServerDTO;
  phase: InstallationPhase;
}

/**
 * Connection facts come from the server row, which the list refreshes from
 * agent heartbeats. The installation badge comes from persisted grant/identity
 * rows, never from whether a script was downloaded.
 */
export function ServerConnectionSummary({
  server,
  phase,
}: ServerConnectionSummaryProps): React.ReactElement {
  const showPhaseNote = phase !== "active" && phase !== "not_started";

  return (
    <section
      data-slot="server-connection-summary"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div>
        <h2 className="font-medium">
          {m.admin_proxies_servers_connection_agent_title()}
        </h2>
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_agent_description()}
        </p>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={m.admin_proxies_servers_connection_installation_label()}>
          <Badge variant={phaseTone[phase]}>{phaseLabel[phase]()}</Badge>
        </Fact>
        <Fact label={m.admin_proxies_servers_connection_agent_status_label()}>
          <ServerStatusBadge server={server} />
        </Fact>
        <Fact label={m.admin_proxies_servers_connection_transport_label()}>
          <span className="text-sm">
            {server.lastSeenAt
              ? server.transportMode === "ws"
                ? m.admin_proxies_servers_connection_transport_ws()
                : m.admin_proxies_servers_connection_transport_http()
              : m.admin_proxies_servers_connection_transport_none()}
          </span>
        </Fact>
        <Fact label={m.admin_proxies_servers_connection_last_seen_label()}>
          <span className="text-sm">
            {server.lastSeenAt
              ? formatDateTime(server.lastSeenAt)
              : m.admin_proxies_servers_connection_never()}
          </span>
        </Fact>
        <Fact label={m.admin_proxies_servers_connection_agent_version_label()}>
          <VersionValue version={server.agentVersion} />
        </Fact>
        <Fact
          label={m.admin_proxies_servers_connection_sing_box_version_label()}
        >
          <VersionValue version={server.singBoxVersion} />
        </Fact>
        <Fact label={m.admin_proxies_servers_connection_runtime_label()}>
          <span className="text-sm">{runtimeLabel[server.runtimeState]()}</span>
        </Fact>
        <Fact label={m.admin_proxies_servers_connection_config_label()}>
          <span className="text-sm">{configLabel[server.configState]()}</span>
        </Fact>
        <Fact
          label={m.admin_proxies_servers_connection_revision_label()}
          className="sm:col-span-2 lg:col-span-1"
        >
          <span className="text-sm tabular-nums">
            {m.admin_proxies_servers_connection_revision_sequence({
              applied: server.appliedRevisionSeq,
              desired: server.desiredRevisionSeq,
            })}
          </span>
        </Fact>
      </dl>

      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-sm font-medium">
          {m.admin_proxies_servers_connection_capabilities_label()}
        </span>
        {server.agentCapabilities.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            {m.admin_proxies_servers_connection_capabilities_empty()}
          </span>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {server.agentCapabilities.map((capability) => (
              <li key={capability}>
                <Badge variant="outline" className="font-mono">
                  {capability}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_capabilities_note()}
        </p>
      </div>

      {showPhaseNote ? (
        <Alert variant={phase === "failed" ? "error" : "warning"}>
          <AlertTitle>{phaseLabel[phase]()}</AlertTitle>
          <AlertDescription>{phaseDescription[phase]()}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
      </dd>
    </div>
  );
}

function VersionValue({
  version,
}: {
  version: string | null;
}): React.ReactElement {
  return (
    <span className="font-mono text-sm">
      {version
        ? `v${version}`
        : m.admin_proxies_servers_connection_version_missing()}
    </span>
  );
}
