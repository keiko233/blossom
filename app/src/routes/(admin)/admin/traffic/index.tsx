import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChartColumnIcon,
  DownloadIcon,
  UsersIcon,
} from "lucide-react";
import type React from "react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { TrafficChart } from "@/components/charts/traffic-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { downloadCsv } from "@/lib/download-csv";
import { formatBytes } from "@/lib/format";
import { changePercent, toUtcDay } from "@/lib/traffic-analytics";
import {
  searchToTrafficFilter,
  searchToTrafficRange,
  type TrafficSearch,
  trafficSearchSchema,
} from "@/lib/traffic-search";
import {
  TRAFFIC_DIMENSIONS,
  type TrafficDimension,
  type TrafficExportKind,
} from "@/orpc/traffic/schema";
import { m } from "@/paraglide/messages";
import {
  exportTrafficCsv,
  getTrafficFilterOptions,
  getTrafficSeries,
  getTrafficSummary,
  TRAFFIC_ANALYTICS_QUERY_KEY,
} from "@/query/traffic-analytics";

import { TrafficBreakdown } from "./_modules/traffic-breakdown";
import { TrafficToolbar } from "./_modules/traffic-toolbar";

export const Route = createFileRoute("/(admin)/admin/traffic/")({
  validateSearch: trafficSearchSchema,
  component: RouteComponent,
});

function dimensionTabLabel(dimension: TrafficDimension): string {
  switch (dimension) {
    case "user":
      return m.admin_traffic_tab_users();
    case "server":
      return m.admin_traffic_tab_servers();
    case "node":
      return m.admin_traffic_tab_nodes();
    case "plan":
      return m.admin_traffic_tab_plans();
  }
}

function exportKindLabel(kind: TrafficExportKind): string {
  return kind === "series"
    ? m.admin_traffic_export_series()
    : dimensionTabLabel(kind);
}

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const routeNavigate = Route.useNavigate();
  const [exportingKind, setExportingKind] = useState<TrafficExportKind>();

  const dimension: TrafficDimension = search.by ?? "user";

  // Presets are aligned to whole UTC hours / days, so the query keys below
  // stay stable between renders of the same hour / day.
  const range = useMemo(
    () => searchToTrafficRange(search, Date.now()),
    [search],
  );
  const filter = useMemo(
    () => searchToTrafficFilter(search, range),
    [search, range],
  );

  const optionsQuery = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "options"],
    queryFn: () => getTrafficFilterOptions(),
    staleTime: 60_000,
  });
  const seriesQuery = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "series", filter],
    queryFn: () => getTrafficSeries({ data: filter }),
    placeholderData: keepPreviousData,
  });
  const summaryQuery = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "summary", filter],
    queryFn: () => getTrafficSummary({ data: filter }),
    placeholderData: keepPreviousData,
  });

  const updateSearch = useCallback(
    (patch: Partial<TrafficSearch>, keepPage = false) => {
      void routeNavigate({
        search: (prev) => ({
          ...prev,
          ...patch,
          ...(keepPage ? {} : { page: undefined }),
        }),
        replace: true,
      });
    },
    [routeNavigate],
  );

  const clearFilters = () => {
    void routeNavigate({
      search: (prev) => ({
        by: prev.by,
        pageSize: prev.pageSize,
        sort: prev.sort,
        dir: prev.dir,
      }),
      replace: true,
    });
  };

  const hasFilters =
    search.range !== undefined ||
    search.from !== undefined ||
    search.to !== undefined ||
    search.server !== undefined ||
    search.node !== undefined ||
    search.plan !== undefined ||
    search.user !== undefined;

  const exportCsv = async (kind: TrafficExportKind) => {
    setExportingKind(kind);
    try {
      const result = await exportTrafficCsv({ data: { ...filter, kind } });
      downloadCsv(
        `traffic-${kind}-${toUtcDay(range.from)}_${toUtcDay(range.to - 1)}.csv`,
        result.csv,
      );
      toastManager.add({
        type: result.truncated ? "warning" : "success",
        title: result.truncated
          ? m.admin_traffic_export_truncated({ count: result.count })
          : m.admin_traffic_export_done({ count: result.count }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_traffic_export_error(),
      });
    } finally {
      setExportingKind(undefined);
    }
  };

  const series = seriesQuery.data;
  const summary = summaryQuery.data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader className="flex-wrap gap-2">
        <div className="flex flex-col gap-0.5">
          <PageHeaderTitle>{m.admin_traffic_title()}</PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_traffic_description()}
          </p>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button loading={exportingKind !== undefined} variant="outline" />
            }
          >
            <DownloadIcon />
            {m.admin_traffic_export()}
          </MenuTrigger>
          <MenuPopup align="end">
            {(["series", ...TRAFFIC_DIMENSIONS] as const).map((kind) => (
              <MenuItem key={kind} onClick={() => void exportCsv(kind)}>
                {exportKindLabel(kind)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </PageHeader>

      <TrafficToolbar
        hasFilters={hasFilters}
        options={optionsQuery.data}
        range={range}
        search={search}
        onChange={updateSearch}
        onClear={clearFilters}
      />

      {summaryQuery.isError || seriesQuery.isError ? (
        <div className="flex flex-col items-center gap-4 py-12">
          <Alert variant="error" className="max-w-md">
            <AlertTitle>{m.admin_traffic_load_error()}</AlertTitle>
            <AlertDescription>
              {(summaryQuery.error ?? seriesQuery.error) instanceof Error
                ? (summaryQuery.error ?? seriesQuery.error)?.message
                : null}
            </AlertDescription>
          </Alert>
          <Button
            loading={summaryQuery.isFetching || seriesQuery.isFetching}
            onClick={() => {
              void summaryQuery.refetch();
              void seriesQuery.refetch();
            }}
          >
            {m.admin_traffic_load_retry()}
          </Button>
        </div>
      ) : (
        <>
          <div
            className={
              summaryQuery.isPlaceholderData
                ? "grid gap-4 opacity-60 transition-opacity sm:grid-cols-2 xl:grid-cols-4"
                : "grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            }
          >
            <StatTile
              change={summary?.changePercent}
              icon={<ChartColumnIcon />}
              label={m.admin_traffic_total()}
              value={summary ? formatBytes(summary.current.total) : null}
            />
            <StatTile
              change={
                summary
                  ? changePercent(
                      summary.current.uplink,
                      summary.previous.uplink,
                    )
                  : null
              }
              icon={<ArrowUpIcon />}
              label={m.admin_traffic_uplink()}
              value={summary ? formatBytes(summary.current.uplink) : null}
            />
            <StatTile
              change={
                summary
                  ? changePercent(
                      summary.current.downlink,
                      summary.previous.downlink,
                    )
                  : null
              }
              icon={<ArrowDownIcon />}
              label={m.admin_traffic_downlink()}
              value={summary ? formatBytes(summary.current.downlink) : null}
            />
            <StatTile
              icon={<UsersIcon />}
              label={m.admin_traffic_active_users()}
              value={summary ? summary.current.activeUsers : null}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{m.admin_traffic_chart_title()}</CardTitle>
              <CardDescription>
                {m.admin_traffic_chart_description()}
              </CardDescription>
            </CardHeader>
            <CardContent
              className={
                seriesQuery.isPlaceholderData
                  ? "opacity-60 transition-opacity"
                  : undefined
              }
            >
              {series ? (
                <TrafficChart
                  buckets={series.buckets}
                  granularity={series.granularity}
                />
              ) : (
                <div className="flex h-60 items-center justify-center">
                  <Spinner />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{m.admin_traffic_breakdown_title()}</CardTitle>
              <CardDescription>
                {m.admin_traffic_breakdown_description()}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Tabs
                value={dimension}
                onValueChange={(next) =>
                  updateSearch({
                    by:
                      next === "user" ? undefined : (next as TrafficDimension),
                    sort: undefined,
                    dir: undefined,
                  })
                }
              >
                <TabsList>
                  {TRAFFIC_DIMENSIONS.map((item) => (
                    <TabsTab key={item} value={item}>
                      {dimensionTabLabel(item)}
                    </TabsTab>
                  ))}
                </TabsList>
              </Tabs>
              <TrafficBreakdown
                dimension={dimension}
                filter={filter}
                search={search}
                onChange={updateSearch}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  change,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  /** Percent change vs the previous equal-length period; undefined hides the line. */
  change?: number | null;
}): React.ReactElement {
  let description: string | undefined;
  if (change !== undefined) {
    description =
      change === null
        ? m.admin_traffic_change_none()
        : m.admin_traffic_change({
            percent: `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
          });
  }
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 [&_svg]:size-4">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {value ?? <Spinner className="size-5" />}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
    </Card>
  );
}
