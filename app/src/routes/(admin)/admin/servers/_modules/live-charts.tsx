import type React from "react";
import { useMemo } from "react";

import {
  MetricLineChart,
  type MetricLineChartLabels,
} from "@/components/charts/metric-line-chart";
import { niceByteTicks } from "@/lib/chart-math";
import { formatBytes } from "@/lib/format";
import { type LiveMetricSample, liveSampleRow } from "@/lib/live-metrics";
import { m } from "@/paraglide/messages";

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

/** The four live charts, directly on the page background in a 2-up grid. */
export function LiveCharts({
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
    <div data-slot="live-charts" className="grid gap-6 md:grid-cols-2">
      <LiveChart title={m.server_live_cpu()}>
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
      </LiveChart>
      <LiveChart title={m.server_live_memory()}>
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
      </LiveChart>
      <LiveChart title={m.server_live_disk()}>
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
      </LiveChart>
      <LiveChart
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
      </LiveChart>
    </div>
  );
}

const EMPTY_CHARTS = [
  { title: m.server_live_cpu, note: null },
  { title: m.server_live_memory, note: null },
  { title: m.server_live_disk, note: null },
  {
    title: m.server_live_network,
    note: m.server_live_network_note,
  },
] as const;

/** Same chart footprint as `LiveCharts`, with the no-samples message. */
export function LiveChartsEmpty(): React.ReactElement {
  return (
    <div data-slot="live-charts-empty" className="grid gap-6 md:grid-cols-2">
      {EMPTY_CHARTS.map(({ title, note }) => (
        <LiveChart key={title()} note={note?.()} title={title()}>
          <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
            {m.server_live_no_samples()}
          </div>
        </LiveChart>
      ))}
    </div>
  );
}

function LiveChart({
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
        <h3 className="text-sm font-semibold">{title}</h3>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </div>
  );
}
