import type React from "react";
import { useMemo } from "react";

import {
  StackedBarChart,
  type StackedBarSeries,
} from "@/components/charts/stacked-bar-chart";
import {
  formatBucketLabel,
  type TrafficBucket,
  type TrafficGranularity,
} from "@/lib/traffic-analytics";
import { m } from "@/paraglide/messages";

export interface TrafficChartProps {
  /** Zero-filled buckets, oldest first. */
  buckets: readonly TrafficBucket[];
  granularity: TrafficGranularity;
  height?: number;
  className?: string;
}

/** Stacked uplink / downlink bars per UTC bucket, with a legend. */
export function TrafficChart({
  buckets,
  granularity,
  height,
  className,
}: TrafficChartProps): React.ReactElement {
  const series = useMemo<StackedBarSeries[]>(
    () => [
      { label: m.admin_traffic_uplink(), color: "var(--chart-up)" },
      { label: m.admin_traffic_downlink(), color: "var(--chart-down)" },
    ],
    [],
  );
  const points = useMemo(
    () =>
      buckets.map((bucket) => ({
        start: bucket.start,
        values: [bucket.uplink, bucket.downlink],
      })),
    [buckets],
  );

  return (
    <div className={className}>
      <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((item) => (
          <li className="flex items-center gap-1.5" key={item.label}>
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-[3px]"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </li>
        ))}
        <li className="ms-auto">
          {granularity === "hour"
            ? m.admin_traffic_granularity_hour()
            : m.admin_traffic_granularity_day()}
        </li>
      </ul>
      <StackedBarChart
        formatX={(start, kind) => formatBucketLabel(start, granularity, kind)}
        height={height}
        labels={{
          chart:
            granularity === "hour"
              ? m.admin_traffic_chart_aria_hour()
              : m.admin_traffic_chart_aria_day(),
          hint: m.admin_traffic_chart_hint(),
          time: m.admin_traffic_chart_time(),
          total: m.admin_traffic_total(),
          timeZone: m.admin_traffic_utc(),
          empty: m.admin_traffic_chart_empty(),
        }}
        points={points}
        series={series}
      />
    </div>
  );
}
