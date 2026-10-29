import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChartColumnIcon } from "lucide-react";
import type React from "react";
import { useEffect } from "react";

import { ListPagination } from "@/components/list-pagination";
import { SortHeader } from "@/components/sort-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import { sharePercent } from "@/lib/traffic-analytics";
import type { TrafficBreakdownRow } from "@/lib/traffic-csv";
import type { TrafficSearch } from "@/lib/traffic-search";
import {
  DEFAULT_TRAFFIC_PAGE_SIZE,
  TRAFFIC_PAGE_SIZES,
  type TrafficBreakdownSort,
  type TrafficDimension,
  type TrafficFilterInput,
} from "@/orpc/traffic/schema";
import { m } from "@/paraglide/messages";
import {
  getTrafficBreakdown,
  TRAFFIC_ANALYTICS_QUERY_KEY,
} from "@/query/traffic-analytics";

export interface TrafficBreakdownProps {
  dimension: TrafficDimension;
  filter: TrafficFilterInput;
  search: TrafficSearch;
  /** Writes a search patch to the URL (the caller resets `page`). */
  onChange: (patch: Partial<TrafficSearch>, keepPage?: boolean) => void;
}

function entityLabel(dimension: TrafficDimension): string {
  switch (dimension) {
    case "user":
      return m.admin_traffic_col_user();
    case "server":
      return m.admin_traffic_col_server();
    case "node":
      return m.admin_traffic_col_node();
    case "plan":
      return m.admin_traffic_col_plan();
  }
}

/** The entity cell: linked to its admin page when it still exists. */
function EntityCell({
  dimension,
  row,
}: {
  dimension: TrafficDimension;
  row: TrafficBreakdownRow;
}): React.ReactElement {
  const { id } = row;
  if (!id) {
    return (
      <span className="text-muted-foreground">
        {m.admin_traffic_unknown_entity()}
      </span>
    );
  }
  const name = row.name ?? id;
  const linkClass = "font-medium hover:underline";
  switch (dimension) {
    case "user":
      return (
        <div className="flex flex-col">
          <Link
            className={linkClass}
            params={{ userId: id }}
            to="/admin/users/$userId"
          >
            {name}
          </Link>
          <span className="text-xs text-muted-foreground">{row.email}</span>
        </div>
      );
    case "server":
      return (
        <Link
          className={linkClass}
          params={{ serverId: id }}
          to="/admin/proxies/servers/$serverId"
        >
          {name}
        </Link>
      );
    case "node":
      return (
        <Link
          className={linkClass}
          params={{ nodeId: id }}
          to="/admin/proxies/nodes/$nodeId"
        >
          {name}
        </Link>
      );
    case "plan":
      return (
        <Link
          className={linkClass}
          params={{ planId: id }}
          to="/admin/plans/$planId"
        >
          {name}
        </Link>
      );
  }
}

/** One breakdown table (sorted and paginated in SQL) with share-of-total bars. */
export function TrafficBreakdown({
  dimension,
  filter,
  search,
  onChange,
}: TrafficBreakdownProps): React.ReactElement {
  const page = search.page ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_TRAFFIC_PAGE_SIZE;
  const sort: TrafficBreakdownSort = search.sort ?? "total";
  const dir = search.dir ?? (sort === "name" ? "asc" : "desc");

  const input = { ...filter, dimension, sort, sortDir: dir, page, pageSize };
  const query = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "breakdown", input],
    queryFn: () => getTrafficBreakdown({ data: input }),
    placeholderData: keepPreviousData,
  });

  const total = query.data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  // A narrower filter (or a hand-edited link) can leave the page past the end.
  useEffect(() => {
    if (query.data && page > pageCount) {
      onChange({ page: pageCount === 1 ? undefined : pageCount }, true);
    }
  }, [query.data, page, pageCount, onChange]);

  const sortBy = (next: TrafficBreakdownSort) => {
    const nextDir =
      next === sort
        ? dir === "desc"
          ? "asc"
          : "desc"
        : next === "name"
          ? "asc"
          : "desc";
    const isDefault = next === "total" && nextDir === "desc";
    onChange({
      sort: isDefault ? undefined : next,
      dir: isDefault ? undefined : nextDir,
    });
  };

  const header = (column: TrafficBreakdownSort, label: string) => (
    <SortHeader
      active={sort === column}
      dir={dir}
      label={label}
      onClick={() => sortBy(column)}
    />
  );

  if (query.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Alert variant="error" className="max-w-md">
          <AlertTitle>{m.admin_traffic_load_error()}</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error ? query.error.message : null}
          </AlertDescription>
        </Alert>
        <Button loading={query.isFetching} onClick={() => void query.refetch()}>
          {m.admin_traffic_load_retry()}
        </Button>
      </div>
    );
  }

  if (total === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChartColumnIcon />
          </EmptyMedia>
          <EmptyTitle>{m.admin_traffic_empty()}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const grandTotal = query.data.grandTotal;

  return (
    <div
      className={query.isPlaceholderData ? "opacity-60 transition-opacity" : ""}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{header("name", entityLabel(dimension))}</TableHead>
            <TableHead className="text-end">
              {header("uplink", m.admin_traffic_uplink())}
            </TableHead>
            <TableHead className="text-end">
              {header("downlink", m.admin_traffic_downlink())}
            </TableHead>
            <TableHead className="text-end">
              {header("total", m.admin_traffic_total())}
            </TableHead>
            <TableHead>{m.admin_traffic_col_share()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.rows.map((row) => {
            const share = sharePercent(row.total, grandTotal);
            return (
              <TableRow key={row.id ?? "unknown"}>
                <TableCell>
                  <EntityCell dimension={dimension} row={row} />
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {formatBytes(row.uplink)}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {formatBytes(row.downlink)}
                </TableCell>
                <TableCell className="text-end font-medium tabular-nums">
                  {formatBytes(row.total)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div
                      aria-hidden="true"
                      className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          backgroundColor: "var(--chart-down)",
                          width: `${Math.min(100, share)}%`,
                        }}
                      />
                    </div>
                    <span className="w-12 text-xs text-muted-foreground tabular-nums">
                      {share.toFixed(1)}%
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ListPagination
        link={(target) => (
          <Link
            from="/admin/traffic/"
            to="/admin/traffic"
            search={(prev) => ({
              ...prev,
              page: target === 1 ? undefined : target,
            })}
          />
        )}
        page={page}
        pageCount={pageCount}
        pageSize={pageSize}
        pageSizes={TRAFFIC_PAGE_SIZES}
        total={total}
        onPageSizeChange={(size) =>
          onChange({
            pageSize: size === DEFAULT_TRAFFIC_PAGE_SIZE ? undefined : size,
          })
        }
      />
    </div>
  );
}
