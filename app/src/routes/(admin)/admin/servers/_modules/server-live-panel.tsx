import type { agentWsTelemetrySnapshotPayloadSchema } from "@blossom/contracts/agent-ws";
import { useMutation } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";

import {
  MetricLineChart,
  type MetricLineChartLabels,
} from "@/components/charts/metric-line-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { adminMetricsServerMessageSchema } from "@/lib/admin-metrics-protocol";
import { niceByteTicks } from "@/lib/chart-math";
import { formatBytes } from "@/lib/format";
import {
  appendLiveSample,
  type LiveMetricSample,
  liveSampleRow,
} from "@/lib/live-metrics";
import { m } from "@/paraglide/messages";
import { checkServerUpdate, type ServerDTO } from "@/query/servers";

type Snapshot = z.infer<typeof agentWsTelemetrySnapshotPayloadSchema>;
type Inspection = Omit<Snapshot, "listeners"> & {
  listeners: (Snapshot["listeners"][number] & { overlapsNode: boolean })[];
};
type LiveStatus = {
  state: "connected" | "fallback" | "legacy" | "disabled" | "unavailable";
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

const scopeLabel = {
  host: m.server_live_scope_host,
  container: m.server_live_scope_container,
};

type StreamPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

async function fetchInspection(
  serverId: string,
  signal?: AbortSignal,
): Promise<LiveStatus> {
  const path = `/api/admin/servers/${encodeURIComponent(serverId)}/stream?inspect=1`;
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Telemetry inspection failed");
  return response.json();
}

function capabilityOf(server: ServerDTO): "v1" | "v2" | null {
  if (server.agentCapabilities.includes("telemetry-v2")) return "v2";
  if (server.agentCapabilities.includes("telemetry-v1")) return "v1";
  return null;
}

function liveStateOf(server: ServerDTO): LiveStatus["state"] {
  if (!server.enabled) return "disabled";
  if (server.transportMode !== "ws" || !server.wsConnectedAt) return "fallback";
  return capabilityOf(server) ? "connected" : "legacy";
}

interface LiveStream {
  phase: StreamPhase;
  protocol: "v1" | "v2" | null;
  samples: LiveMetricSample[];
  error: string | null;
}

/**
 * Same-origin admin metric stream. The server coalesces sampling and sends
 * one sample per interval regardless of how many admins watch. The browser
 * keeps a bounded window and drops it when the stream closes, so a reconnect
 * or agent restart starts a new, gap-aware series.
 */
function useLiveMetrics(serverId: string, active: boolean): LiveStream {
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const [protocol, setProtocol] = useState<"v1" | "v2" | null>(null);
  const [samples, setSamples] = useState<LiveMetricSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    if (!active) {
      setPhase("idle");
      setSamples([]);
      return;
    }
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      setPhase((current) =>
        current === "connected" || current === "connecting"
          ? current
          : "reconnecting",
      );
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${scheme}//${window.location.host}/api/admin/servers/${encodeURIComponent(serverId)}/metrics/ws`,
      );
      socket.addEventListener("open", () => {
        attempts.current = 0;
        setPhase("connecting");
        setError(null);
      });
      socket.addEventListener("message", (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = adminMetricsServerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "state") {
          setProtocol(message.protocol);
          setPhase("connected");
          setError(null);
          return;
        }
        if (message.type === "sample") {
          setSamples((current) => appendLiveSample(current, message.sample));
          return;
        }
        if (message.type === "error") {
          setError(message.message);
          setPhase("error");
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setPhase("reconnecting");
        setSamples([]);
        const delay = Math.min(30_000, 1_000 * 2 ** attempts.current);
        attempts.current += 1;
        retry = setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => setPhase("error"));
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [active, serverId]);

  return { phase, protocol, samples, error };
}

export function ServerLivePanel({
  server,
}: {
  server: ServerDTO;
}): React.ReactElement {
  const state = liveStateOf(server);
  const live = useLiveMetrics(server.id, state === "connected");
  const inspection = useMutation({
    mutationFn: () => fetchInspection(server.id),
    gcTime: 0,
  });
  const update = useMutation({
    mutationFn: (target: "agent" | "sing-box") =>
      checkServerUpdate({ data: { id: server.id, target } }),
  });
  const latest = live.samples.at(-1);

  return (
    <section
      data-slot="server-live-panel"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{m.server_live_title()}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{transportLabel[state]()}</Badge>
          {live.protocol && <Badge variant="secondary">{live.protocol}</Badge>}
        </div>
      </div>
      {state === "connected" && (
        <p role="status" className="text-sm text-muted-foreground">
          {live.error
            ? live.error
            : live.phase === "connected"
              ? m.server_live_stream_connected()
              : live.phase === "reconnecting"
                ? m.server_live_stream_reconnecting()
                : m.server_live_stream_connecting()}
        </p>
      )}
      {latest && (
        <>
          <ResourceGauges sample={latest} />
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              {environmentLabel[latest.environment]()}
            </Badge>
            <Badge variant="outline">{scopeLabel[latest.scope]()}</Badge>
          </div>
        </>
      )}
      {live.samples.length > 0 && <LiveCharts samples={live.samples} />}
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

function usageText(used: number | null, total: number | null): string {
  return used !== null && total !== null
    ? m.server_live_usage({ used: gib(used), total: gib(total) })
    : m.server_live_missing();
}

function usagePercent(
  used: number | null,
  total: number | null,
): number | null {
  return used !== null && total !== null && total > 0
    ? (100 * used) / total
    : null;
}

function ResourceGauges({
  sample,
}: {
  sample: LiveMetricSample;
}): React.ReactElement {
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
      value: usagePercent(sample.memoryUsedBytes, sample.memoryTotalBytes),
      display: usageText(sample.memoryUsedBytes, sample.memoryTotalBytes),
    },
    {
      label: m.server_live_disk(),
      value: usagePercent(sample.diskUsedBytes, sample.diskTotalBytes),
      display: usageText(sample.diskUsedBytes, sample.diskTotalBytes),
    },
  ];
  return (
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
  );
}

const PERCENT_AXIS = { ticks: [0, 25, 50, 75, 100], max: 100 } as const;

function liveTime(start: number, kind: "axis" | "full"): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    hourCycle: "h23",
    ...(kind === "full"
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { minute: "2-digit", second: "2-digit" }),
  }).format(new Date(start));
}

function chartLabels(chart: string, empty: string): MetricLineChartLabels {
  return {
    chart,
    hint: m.admin_traffic_chart_hint(),
    time: m.admin_traffic_chart_time(),
    timeZone: m.admin_traffic_utc(),
    empty,
    missing: m.server_history_chart_missing(),
    scopeChanged: m.server_history_scope_changed(),
  };
}

function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function LiveCharts({
  samples,
}: {
  samples: LiveMetricSample[];
}): React.ReactElement {
  const points = useMemo(() => samples.map(liveSampleRow), [samples]);
  const rateAxis = useMemo(() => {
    const peak = Math.max(
      0,
      ...points.flatMap((point) => [
        point.networkTxBytesPerSecond ?? 0,
        point.networkRxBytesPerSecond ?? 0,
      ]),
    );
    return niceByteTicks(peak);
  }, [points]);

  return (
    <div className="grid gap-4 border-t pt-4 md:grid-cols-2">
      <LiveCard title={m.server_live_cpu()}>
        <MetricLineChart
          axis={PERCENT_AXIS}
          formatValue={formatPercent}
          formatX={liveTime}
          labels={chartLabels(m.server_live_cpu(), m.server_live_no_samples())}
          points={points}
          series={[
            {
              label: m.server_live_cpu(),
              color: "var(--chart-1)",
              value: (point) => point.cpuPercent,
            },
          ]}
        />
      </LiveCard>
      <LiveCard title={m.server_live_memory()}>
        <MetricLineChart
          axis={PERCENT_AXIS}
          formatValue={formatPercent}
          formatX={liveTime}
          labels={chartLabels(
            m.server_live_memory(),
            m.server_live_no_samples(),
          )}
          points={points}
          series={[
            {
              label: m.server_live_memory(),
              color: "var(--chart-1)",
              value: (point) => point.memoryPercent,
            },
          ]}
        />
      </LiveCard>
      <LiveCard title={m.server_live_disk()}>
        <MetricLineChart
          axis={PERCENT_AXIS}
          formatValue={formatPercent}
          formatX={liveTime}
          labels={chartLabels(m.server_live_disk(), m.server_live_no_samples())}
          points={points}
          series={[
            {
              label: m.server_live_disk(),
              color: "var(--chart-1)",
              value: (point) => point.diskPercent,
            },
          ]}
        />
      </LiveCard>
      <LiveCard
        title={m.server_live_network()}
        note={m.server_live_network_note()}
      >
        <MetricLineChart
          axis={rateAxis}
          formatValue={formatRate}
          formatX={liveTime}
          labels={chartLabels(
            m.server_live_network(),
            m.server_live_no_samples(),
          )}
          points={points}
          series={[
            {
              label: m.server_live_network_tx(),
              color: "var(--chart-up)",
              value: (point) => point.networkTxBytesPerSecond,
            },
            {
              label: m.server_live_network_rx(),
              color: "var(--chart-down)",
              value: (point) => point.networkRxBytesPerSecond,
            },
          ]}
        />
      </LiveCard>
    </div>
  );
}

function LiveCard({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </div>
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
