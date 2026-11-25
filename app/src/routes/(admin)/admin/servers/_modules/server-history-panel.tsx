import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type React from "react";
import { useMemo, useState } from "react";

import { ChartSkeleton } from "@/components/app-shell/skeletons";
import {
  MetricLineChart,
  type MetricLineAxis,
  type MetricLineChartLabels,
  type MetricLineSeries,
} from "@/components/charts/metric-line-chart";
import { Button } from "@/components/ui/button";
import { niceByteTicks } from "@/lib/chart-math";
import { formatBytes } from "@/lib/format";
import {
  type MetricHistoryRow,
  SERVER_METRIC_RANGES,
  type ServerMetricRange,
} from "@/lib/server-metric-history";
import { m } from "@/paraglide/messages";
import {
  getServerMetricHistory,
  SERVER_METRIC_HISTORY_QUERY_KEY,
} from "@/query/server-metric-history";

const PERCENT_AXIS: MetricLineAxis = {
  ticks: [0, 25, 50, 75, 100],
  max: 100,
};

const rangeLabel: Record<ServerMetricRange, () => string> = {
  "1h": m.server_history_range_1h,
  "24h": m.server_history_range_24h,
  "7d": m.server_history_range_7d,
  "30d": m.server_history_range_30d,
};

const EMPTY_POINTS: MetricHistoryRow[] = [];

function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

/** UTC wall-clock label; multi-day ranges show the date on the axis. */
function formatHistoryTime(
  start: number,
  kind: "axis" | "full",
  wideRange: boolean,
): string {
  const showDate = kind === "full" || wideRange;
  const showTime = kind === "full" || !wideRange;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    hourCycle: "h23",
    ...(showDate ? { month: "short", day: "numeric" } : {}),
    ...(showTime ? { hour: "2-digit", minute: "2-digit" } : {}),
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

export interface ServerHistoryPanelProps {
  serverId: string;
}

/**
 * Overview history: PostgreSQL-backed host metrics for a preset range. The
 * data is fetched by an admin server function and downsampled on the server.
 * Switching ranges keeps the previous charts visible while the next loads.
 */
export function ServerHistoryPanel({
  serverId,
}: ServerHistoryPanelProps): React.ReactElement {
  const [range, setRange] = useState<ServerMetricRange>("24h");
  const history = useQuery({
    queryKey: [...SERVER_METRIC_HISTORY_QUERY_KEY, serverId, range],
    queryFn: () => getServerMetricHistory({ data: { serverId, range } }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const points = history.data?.points ?? EMPTY_POINTS;
  const wideRange = range === "7d" || range === "30d";
  const rateAxis = useMemo<MetricLineAxis>(() => {
    const peak = Math.max(
      0,
      ...points.flatMap((point) => [
        point.networkTxBytesPerSecond ?? 0,
        point.networkRxBytesPerSecond ?? 0,
      ]),
    );
    return niceByteTicks(peak);
  }, [points]);

  const cpu: MetricLineSeries[] = [
    {
      label: m.server_history_cpu(),
      color: "var(--chart-1)",
      value: (point) => point.cpuPercent,
    },
  ];
  const memory: MetricLineSeries[] = [
    {
      label: m.server_history_memory(),
      color: "var(--chart-1)",
      value: (point) => point.memoryPercent,
    },
  ];
  const disk: MetricLineSeries[] = [
    {
      label: m.server_history_disk(),
      color: "var(--chart-1)",
      value: (point) => point.diskPercent,
    },
  ];
  const network: MetricLineSeries[] = [
    {
      label: m.server_history_network_tx(),
      color: "var(--chart-up)",
      value: (point) => point.networkTxBytesPerSecond,
    },
    {
      label: m.server_history_network_rx(),
      color: "var(--chart-down)",
      value: (point) => point.networkRxBytesPerSecond,
    },
  ];

  const since = history.data?.historySinceMs;
  const summary =
    since === undefined
      ? m.server_history_note()
      : since === null
        ? m.server_history_none()
        : m.server_history_since({
            time: formatHistoryTime(since, "full", true),
          });

  return (
    <section
      data-slot="server-history-panel"
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">{m.server_history_title()}</h2>
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
        <div
          aria-label={m.server_history_range_label()}
          className="flex flex-wrap gap-1"
          role="group"
        >
          {SERVER_METRIC_RANGES.map((value) => (
            <Button
              aria-pressed={range === value}
              key={value}
              size="sm"
              variant={range === value ? "secondary" : "outline"}
              onClick={() => setRange(value)}
            >
              {rangeLabel[value]()}
            </Button>
          ))}
        </div>
      </div>

      {history.isError ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {m.server_history_load_error()}
        </p>
      ) : history.isPending ? (
        <div className="grid gap-6 md:grid-cols-2">
          <ChartSkeleton />
          <ChartSkeleton />
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      ) : (
        <div
          className={
            history.isPlaceholderData
              ? "grid gap-4 opacity-60 transition-opacity md:grid-cols-2"
              : "grid gap-4 transition-opacity md:grid-cols-2"
          }
        >
          <HistoryCard title={m.server_history_cpu()}>
            <MetricLineChart
              axis={PERCENT_AXIS}
              formatValue={formatPercent}
              formatX={(start, kind) =>
                formatHistoryTime(start, kind, wideRange)
              }
              labels={chartLabels(
                m.server_history_cpu(),
                m.server_history_chart_empty(),
              )}
              points={points}
              series={cpu}
            />
          </HistoryCard>
          <HistoryCard title={m.server_history_memory()}>
            <MetricLineChart
              axis={PERCENT_AXIS}
              formatValue={formatPercent}
              formatX={(start, kind) =>
                formatHistoryTime(start, kind, wideRange)
              }
              labels={chartLabels(
                m.server_history_memory(),
                m.server_history_chart_empty(),
              )}
              points={points}
              series={memory}
            />
          </HistoryCard>
          <HistoryCard title={m.server_history_disk()}>
            <MetricLineChart
              axis={PERCENT_AXIS}
              formatValue={formatPercent}
              formatX={(start, kind) =>
                formatHistoryTime(start, kind, wideRange)
              }
              labels={chartLabels(
                m.server_history_disk(),
                m.server_history_chart_empty(),
              )}
              points={points}
              series={disk}
            />
          </HistoryCard>
          <HistoryCard
            note={m.server_history_network_note()}
            title={m.server_history_network()}
          >
            <MetricLineChart
              axis={rateAxis}
              formatValue={formatRate}
              formatX={(start, kind) =>
                formatHistoryTime(start, kind, wideRange)
              }
              labels={chartLabels(
                m.server_history_network(),
                m.server_history_chart_empty(),
              )}
              points={points}
              series={network}
            />
          </HistoryCard>
        </div>
      )}
    </section>
  );
}

function HistoryCard({
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
