import type {
  agentWsTelemetrySamplePayloadSchema,
  agentWsTelemetrySnapshotPayloadSchema,
} from "@blossom/contracts/agent-ws";
import { useMutation, useQuery } from "@tanstack/react-query";
import type React from "react";
import type { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { m } from "@/paraglide/messages";
import { checkServerUpdate } from "@/query/servers";

type Sample = z.infer<typeof agentWsTelemetrySamplePayloadSchema>;
type Snapshot = z.infer<typeof agentWsTelemetrySnapshotPayloadSchema>;
type Inspection = Omit<Snapshot, "listeners"> & {
  listeners: (Snapshot["listeners"][number] & { overlapsNode: boolean })[];
};
type LiveStatus = {
  state: "connected" | "fallback" | "legacy" | "disabled" | "unavailable";
  sample?: Sample;
  snapshot?: Inspection;
};

const transportLabel = {
  connected: m.server_live_connected,
  fallback: m.server_live_fallback,
  legacy: m.server_live_legacy,
  disabled: m.server_live_disabled,
  unavailable: m.server_live_unavailable,
};

const environmentLabel = {
  systemd: m.server_live_environment_systemd,
  docker: m.server_live_environment_docker,
  containerd: m.server_live_environment_containerd,
  kubernetes: m.server_live_environment_kubernetes,
  container: m.server_live_environment_container,
  unknown: m.server_live_environment_unknown,
};

const updateLabel = {
  requested: m.server_live_update_requested,
  polling: m.server_live_update_polling,
  unmanaged: m.server_live_update_unmanaged,
};

async function fetchStatus(
  serverId: string,
  inspect: boolean,
  signal?: AbortSignal,
): Promise<LiveStatus> {
  const path = `/api/admin/servers/${encodeURIComponent(serverId)}/stream`;
  const response = await fetch(inspect ? `${path}?inspect=1` : path, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Telemetry request failed");
  return response.json();
}

export function ServerLivePanel({
  serverId,
}: {
  serverId: string;
}): React.ReactElement {
  const status = useQuery({
    queryKey: ["admin", "server-telemetry", serverId],
    queryFn: ({ signal }) => fetchStatus(serverId, false, signal),
    refetchInterval: 6_000,
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 0,
  });
  const inspection = useMutation({
    mutationFn: () => fetchStatus(serverId, true),
    gcTime: 0,
  });
  const update = useMutation({
    mutationFn: (target: "agent" | "sing-box") =>
      checkServerUpdate({ data: { id: serverId, target } }),
  });
  const state = status.isError ? "unavailable" : status.data?.state;
  const sample = state === "connected" ? status.data?.sample : undefined;

  return (
    <section
      data-slot="server-live-panel"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{m.server_live_title()}</h2>
        <Badge variant="outline">
          {state ? transportLabel[state]() : m.server_live_loading()}
        </Badge>
      </div>
      {sample && <ResourceGauges sample={sample} />}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={state !== "connected" || inspection.isPending}
          onClick={() => inspection.mutate()}
        >
          {m.server_live_inspect()}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={state === "disabled" || update.isPending}
          onClick={() => update.mutate("agent")}
        >
          {m.server_live_update_agent()}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={state === "disabled" || update.isPending}
          onClick={() => update.mutate("sing-box")}
        >
          {m.server_live_update_singbox()}
        </Button>
      </div>
      <div role="status" className="text-sm text-muted-foreground">
        {update.isError
          ? m.server_live_update_failed()
          : update.data && updateLabel[update.data]()}
        {state === "connected" &&
          (inspection.isError ||
            (inspection.data && !inspection.data.snapshot)) && (
            <p>{m.server_live_unavailable()}</p>
          )}
      </div>
      {state === "connected" && inspection.data?.snapshot && (
        <NetworkInspection snapshot={inspection.data.snapshot} />
      )}
    </section>
  );
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function usageText(usage: Sample["memory"]): string {
  return usage
    ? m.server_live_usage({ used: gib(usage.used), total: gib(usage.total) })
    : m.server_live_missing();
}

function usagePercent(usage: Sample["memory"]): number | null {
  return usage?.total ? (100 * usage.used) / usage.total : null;
}

function ResourceGauges({ sample }: { sample: Sample }): React.ReactElement {
  const gauges = [
    {
      label: m.server_live_cpu(),
      value: sample.cpuPercent,
      display:
        sample.cpuPercent === null
          ? m.server_live_missing()
          : `${sample.cpuPercent.toFixed(1)}%`,
    },
    {
      label: m.server_live_memory(),
      value: usagePercent(sample.memory),
      display: usageText(sample.memory),
    },
    {
      label: m.server_live_disk(),
      value: usagePercent(sample.disk),
      display: usageText(sample.disk),
    },
  ];
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        {gauges.map(({ label, value, display }) => (
          <div key={label} className="space-y-1">
            <div className="text-sm font-medium">{label}</div>
            {value !== null && <Progress aria-label={label} value={value} />}
            <div className="text-sm text-muted-foreground tabular-nums">
              {display}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          {environmentLabel[sample.environment]()}
        </Badge>
        {sample.cgroupVersion && (
          <Badge variant="outline">
            {m.server_live_cgroup({ version: sample.cgroupVersion })}
          </Badge>
        )}
      </div>
      {sample.cgroupVersion && (
        <p className="text-sm text-muted-foreground">
          {m.server_live_limits({
            cpu: sample.cpuLimit?.toFixed(2) ?? m.server_live_missing(),
            memory:
              sample.memoryLimit === null
                ? m.server_live_missing()
                : gib(sample.memoryLimit),
          })}
        </p>
      )}
    </>
  );
}

function NetworkInspection({
  snapshot,
}: {
  snapshot: Inspection;
}): React.ReactElement {
  return (
    <div className="grid gap-4 border-t pt-4 text-sm sm:grid-cols-2">
      <p className="text-muted-foreground sm:col-span-2">
        {m.server_live_namespace()}{" "}
        {snapshot.partial && m.server_live_partial()}
      </p>
      <div>
        <h3 className="font-medium">{m.server_live_ports()}</h3>
        <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-auto">
          {snapshot.listeners.length === 0 && <li>{m.server_live_empty()}</li>}
          {snapshot.listeners.map(
            ({ protocol, address, port, overlapsNode }) => (
              <li
                key={`${protocol}/${address}/${port}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-mono">
                  {protocol.toUpperCase()}{" "}
                  {address.includes(":") ? `[${address}]` : address}:{port}
                </span>
                {overlapsNode && (
                  <Badge variant="outline">{m.server_live_overlap()}</Badge>
                )}
              </li>
            ),
          )}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">{m.server_live_interfaces()}</h3>
        <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-auto">
          {snapshot.interfaces.length === 0 && <li>{m.server_live_empty()}</li>}
          {snapshot.interfaces.map(({ name, address }) => (
            <li key={`${name}/${address}`} className="font-mono wrap-anywhere">
              {name} {address}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
