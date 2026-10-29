import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChartColumnIcon } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import { TrafficChart } from "@/components/charts/traffic-chart";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/format";
import { presetToRange } from "@/lib/traffic-analytics";
import { m } from "@/paraglide/messages";
import {
  getTrafficSeries,
  TRAFFIC_ANALYTICS_QUERY_KEY,
} from "@/query/traffic-analytics";

export interface TrafficTrendProps {
  /** Scope the chart to one server or one user. */
  serverId?: string;
  userId?: string;
}

/**
 * Compact 30-day traffic chart of one server or user, with a link to the
 * analytics page prefiltered the same way.
 */
export function TrafficTrend({
  serverId,
  userId,
}: TrafficTrendProps): React.ReactElement {
  // Day-aligned, so the query key stays stable for the whole UTC day.
  const range = useMemo(() => presetToRange("30d", Date.now()), []);
  const filter = {
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    serverId,
    userId,
  };
  const { data, isPending, isError } = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "trend", filter],
    queryFn: () => getTrafficSeries({ data: filter }),
  });

  const total = data?.buckets.reduce(
    (sum, bucket) => sum + bucket.uplink + bucket.downlink,
    0,
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-heading text-base font-semibold">
            {m.admin_traffic_trend_title()}
          </h2>
          {total === undefined ? null : (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatBytes(total)}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              search={{ server: serverId, user: userId }}
              to="/admin/traffic"
            />
          }
        >
          <ChartColumnIcon />
          {m.admin_traffic_view_in_analytics()}
        </Button>
      </div>
      <div className="rounded-xl border bg-card p-4 shadow-xs">
        {isPending ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : isError || !data ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {m.admin_traffic_load_error()}
          </p>
        ) : (
          <TrafficChart
            buckets={data.buckets}
            granularity={data.granularity}
            height={176}
          />
        )}
      </div>
    </section>
  );
}
