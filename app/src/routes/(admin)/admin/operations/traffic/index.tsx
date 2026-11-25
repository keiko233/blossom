import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderTitle,
  PageToolbar,
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { ChartSkeleton } from "@/components/app-shell/skeletons";
import { StatStrip, StatStripItem } from "@/components/app-shell/stat-strip";
import { TrafficChart } from "@/components/charts/traffic-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
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

export const Route = createFileRoute("/(admin)/admin/operations/traffic/")({
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
    <>
      <PageHeader>
        <div className="flex min-w-0 items-baseline gap-3">
          <PageHeaderTitle>{m.admin_traffic_title()}</PageHeaderTitle>
          <PageHeaderDescription className="hidden lg:block">
            {m.admin_traffic_description()}
          </PageHeaderDescription>
        </div>
        <PageHeaderActions>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  loading={exportingKind !== undefined}
                  size="sm"
                  variant="outline"
                />
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
        </PageHeaderActions>
      </PageHeader>

      <PageToolbar>
        <TrafficToolbar
          hasFilters={hasFilters}
          options={optionsQuery.data}
          range={range}
          search={search}
          onChange={updateSearch}
          onClear={clearFilters}
        />
      </PageToolbar>

      <PageContent>
        {summaryQuery.isError || seriesQuery.isError ? (
          <div className="flex flex-col items-start gap-4 py-12">
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
              size="sm"
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
                  ? "opacity-60 transition-opacity"
                  : undefined
              }
            >
              {summary ? (
                <StatStrip columns={4}>
                  <StatStripItem
                    detail={changeSummary(summary.changePercent)}
                    label={m.admin_traffic_total()}
                    value={formatBytes(summary.current.total)}
                  />
                  <StatStripItem
                    detail={changeSummary(
                      changePercent(
                        summary.current.uplink,
                        summary.previous.uplink,
                      ),
                    )}
                    label={m.admin_traffic_uplink()}
                    value={formatBytes(summary.current.uplink)}
                  />
                  <StatStripItem
                    detail={changeSummary(
                      changePercent(
                        summary.current.downlink,
                        summary.previous.downlink,
                      ),
                    )}
                    label={m.admin_traffic_downlink()}
                    value={formatBytes(summary.current.downlink)}
                  />
                  <StatStripItem
                    label={m.admin_traffic_active_users()}
                    value={summary.current.activeUsers}
                  />
                </StatStrip>
              ) : (
                <SummarySkeleton />
              )}
            </div>

            <section className="flex min-w-0 flex-col gap-3">
              <SectionHeader>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <SectionTitle>{m.admin_traffic_chart_title()}</SectionTitle>
                  <span className="text-xs text-muted-foreground">
                    {m.admin_traffic_chart_description()}
                  </span>
                </div>
              </SectionHeader>
              <div
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
                  <ChartSkeleton className="h-60" />
                )}
              </div>
            </section>

            <section className="flex min-w-0 flex-col gap-3">
              <SectionHeader>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <SectionTitle>
                    {m.admin_traffic_breakdown_title()}
                  </SectionTitle>
                  <span className="text-xs text-muted-foreground">
                    {m.admin_traffic_breakdown_description()}
                  </span>
                </div>
              </SectionHeader>
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
            </section>
          </>
        )}
      </PageContent>
    </>
  );
}

function changeSummary(change: number | null): string {
  return change === null
    ? m.admin_traffic_change_none()
    : m.admin_traffic_change({
        percent: `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
      });
}

function SummarySkeleton() {
  return (
    <div
      className="grid divide-y border-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4"
      aria-busy="true"
    >
      {Array.from({ length: 4 }, (_, item) => (
        <div key={item} className="flex flex-col gap-2 px-4 py-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
