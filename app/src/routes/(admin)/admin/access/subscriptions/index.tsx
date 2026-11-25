import {
  type BulkSubscriptionActionInput,
  SUBSCRIPTION_PAGE_SIZES,
  type subscriptionSortSchema,
} from "@blossom/contracts/plan";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  type RowSelectionState,
  useReactTable,
} from "@tanstack/react-table";
import {
  DownloadIcon,
  EllipsisIcon,
  ListChecksIcon,
  ReceiptTextIcon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import type { z } from "zod";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
  PageToolbar,
} from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { ListPagination } from "@/components/list-pagination";
import { SortHeader } from "@/components/sort-header";
import {
  SubscriptionQuotaUsage,
  SubscriptionStatusBadge,
} from "@/components/subscriptions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { snapshotDrift } from "@/lib/access-impact";
import { downloadCsv } from "@/lib/download-csv";
import { formatDate, formatTraffic } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import { getEffectiveSubscriptionStatus } from "@/lib/subscription-helpers";
import {
  DEFAULT_PAGE_SIZE,
  searchToFilter,
  type SubscriptionsSearch,
  subscriptionsSearchSchema,
} from "@/lib/subscription-search";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";
import {
  bulkUpdateSubscriptions,
  exportSubscriptionsCsv,
  listSubscriptions,
  type SubscriptionListItem,
  SUBSCRIPTIONS_QUERY_KEY,
} from "@/query/subscriptions";
import { USERS_QUERY_KEY } from "@/query/users";

import {
  BulkActionDialog,
  type BulkActionKind,
} from "./_modules/bulk-action-dialog";
import { SubscriptionToolbar } from "./_modules/subscription-toolbar";
import { useSubscriptionActions } from "./_modules/use-subscription-actions";

export const Route = createFileRoute("/(admin)/admin/access/subscriptions/")({
  validateSearch: subscriptionsSearchSchema,
  component: RouteComponent,
});

const columnHelper = createColumnHelper<SubscriptionListItem>();

type SortColumn = z.infer<typeof subscriptionSortSchema>;

const BULK_KINDS: { kind: BulkActionKind; label: () => string }[] = [
  { kind: "extend", label: () => m.admin_subscriptions_bulk_extend() },
  {
    kind: "resetTraffic",
    label: () => m.admin_subscriptions_bulk_reset_traffic(),
  },
  { kind: "setStatus", label: () => m.admin_subscriptions_bulk_status() },
  { kind: "changePlan", label: () => m.admin_subscriptions_bulk_plan() },
];

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [searchResetToken, setSearchResetToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const page = search.page ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const filter = searchToFilter(search);
  const listInput = { ...filter, page, pageSize };

  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [...SUBSCRIPTIONS_QUERY_KEY, "list", listInput],
    queryFn: () => listSubscriptions({ data: listInput }),
    placeholderData: keepPreviousData,
  });
  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  const filteredPlan = search.plan
    ? plans?.find((candidate) => candidate.id === search.plan)
    : undefined;

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  // Deleting the last rows of the final page leaves it empty: step back.
  useEffect(() => {
    if (data && page > pageCount) {
      void navigate({
        search: (prev) => ({
          ...prev,
          page: pageCount === 1 ? undefined : pageCount,
        }),
        replace: true,
      });
    }
  }, [data, page, pageCount, navigate]);

  // Selection is per view: it must not leak across pages or filters.
  const viewKey = JSON.stringify(listInput);
  useEffect(() => {
    setRowSelection({});
  }, [viewKey]);

  // Also refreshes the per-user subscription counts on the users list.
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY }),
    ]);
  };

  const actions = useSubscriptionActions(invalidate);

  const updateSearch = (patch: Partial<SubscriptionsSearch>) => {
    void navigate({
      search: (prev) => ({ ...prev, ...patch, page: undefined }),
      replace: true,
    });
  };

  const clearFilters = () => {
    setSearchResetToken((token) => token + 1);
    void navigate({
      search: (prev) => ({
        pageSize: prev.pageSize,
        sort: prev.sort,
        dir: prev.dir,
      }),
      replace: true,
    });
  };

  const hasFilters =
    search.q !== undefined ||
    search.status !== undefined ||
    search.plan !== undefined ||
    search.expiring !== undefined ||
    search.quota !== undefined;

  const toggleSort = (column: SortColumn) => {
    const active = (search.sort ?? "createdAt") === column;
    const dir = search.dir ?? "desc";
    updateSearch({
      sort: column,
      dir: active ? (dir === "asc" ? "desc" : "asc") : "desc",
    });
  };

  const bulkMutation = useMutation({
    mutationFn: (input: BulkSubscriptionActionInput) =>
      bulkUpdateSubscriptions({
        data: { ids: Object.keys(rowSelection), action: input },
      }),
    onSuccess: async (result) => {
      setRowSelection({});
      await invalidate();
      toastManager.add({
        type: result.failed.length > 0 ? "warning" : "success",
        title: m.admin_subscriptions_bulk_toast_title(),
        description: m.admin_subscriptions_bulk_toast_result({
          succeeded: result.succeeded,
          failed: result.failed.length,
        }),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_subscriptions_toast_error(),
      });
    },
  });

  const requestBulk = async (kind: BulkActionKind) => {
    await BulkActionDialog.call({
      kind,
      count: Object.keys(rowSelection).length,
      onSubmit: (action) => bulkMutation.mutateAsync(action),
    });
  };

  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const result = await exportSubscriptionsCsv({ data: filter });
      downloadCsv(
        `subscriptions-${new Date().toISOString().slice(0, 10)}.csv`,
        result.csv,
      );
      toastManager.add({
        type: result.truncated ? "warning" : "success",
        title: result.truncated
          ? m.admin_subscriptions_export_truncated({ count: result.count })
          : m.admin_subscriptions_export_done({ count: result.count }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_subscriptions_export_error(),
      });
    } finally {
      setIsExporting(false);
    }
  };

  const sortHeader = (column: SortColumn, label: string) => (
    <SortHeader
      active={(search.sort ?? "createdAt") === column}
      dir={search.dir ?? "desc"}
      label={label}
      onClick={() => toggleSort(column)}
    />
  );

  const columns = [
    columnHelper.display({
      id: "select",
      header: ({ table }) => (
        <Checkbox
          aria-label={m.admin_subscriptions_select_all()}
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onCheckedChange={(checked) =>
            table.toggleAllPageRowsSelected(checked)
          }
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={m.admin_subscriptions_select_row()}
          checked={row.getIsSelected()}
          onCheckedChange={(checked) => row.toggleSelected(checked)}
        />
      ),
    }),
    columnHelper.accessor("userName", {
      header: () => m.admin_subscriptions_col_user(),
      cell: (info) => {
        const sub = info.row.original;
        return (
          <Link
            className="flex flex-col gap-0.5"
            params={{ userId: sub.userId }}
            to="/admin/access/users/$userId"
          >
            <span className="font-medium hover:underline">{sub.userName}</span>
            <span className="text-xs text-muted-foreground">
              {sub.userEmail}
            </span>
          </Link>
        );
      },
    }),
    columnHelper.accessor("planName", {
      header: () => m.admin_subscriptions_col_plan(),
      cell: (info) => (
        <Link
          className="font-medium hover:underline"
          params={{ planId: info.row.original.planId }}
          to="/admin/access/plans/$planId"
        >
          {info.getValue()}
        </Link>
      ),
    }),
    columnHelper.display({
      id: "status",
      header: () => m.admin_subscriptions_col_status(),
      cell: ({ row }) => (
        <SubscriptionStatusBadge
          status={getEffectiveSubscriptionStatus(row.original)}
        />
      ),
    }),
    columnHelper.accessor("expiresAt", {
      header: () => sortHeader("expiresAt", m.admin_subscriptions_col_period()),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {formatDate(row.original.startedAt)} –{" "}
          {formatDate(row.original.expiresAt)}
        </span>
      ),
    }),
    columnHelper.display({
      id: "usage",
      header: () => sortHeader("usage", m.admin_subscriptions_col_traffic()),
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <SubscriptionQuotaUsage
            trafficQuotaBytes={row.original.trafficQuotaBytes}
            trafficUsedBytes={row.original.trafficUsedBytes}
          />
          {snapshotDrift(row.original, {
            trafficBytes: row.original.planTrafficBytes,
            deviceLimit: row.original.planDeviceLimit,
          }).traffic ? (
            <span className="text-xs text-muted-foreground">
              {m.admin_subscriptions_plan_now({
                value:
                  row.original.planTrafficBytes === 0
                    ? m.admin_plans_device_unlimited()
                    : formatTraffic(row.original.planTrafficBytes),
              })}
            </span>
          ) : null}
        </div>
      ),
    }),
    columnHelper.accessor("deviceLimit", {
      header: () => m.admin_subscriptions_col_devices(),
      cell: (info) => {
        const sub = info.row.original;
        const drifted = snapshotDrift(sub, {
          trafficBytes: sub.planTrafficBytes,
          deviceLimit: sub.planDeviceLimit,
        }).devices;
        return (
          <div className="flex flex-col gap-0.5">
            {info.getValue() === 0 ? (
              <span className="text-xs text-muted-foreground">
                {m.admin_subscriptions_devices_unlimited()}
              </span>
            ) : (
              info.getValue()
            )}
            {drifted ? (
              <span className="text-xs text-muted-foreground">
                {m.admin_subscriptions_plan_now({
                  value:
                    sub.planDeviceLimit === 0
                      ? m.admin_plans_device_unlimited()
                      : sub.planDeviceLimit,
                })}
              </span>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("createdAt", {
      header: () =>
        sortHeader("createdAt", m.admin_subscriptions_col_created()),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {formatDate(info.getValue())}
        </span>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const sub = row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={actions.pendingId === sub.id}
                    size="icon"
                    variant="ghost"
                  />
                }
                aria-label="Actions"
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  render={
                    <Link
                      params={{ userId: sub.userId }}
                      to="/admin/access/users/$userId"
                    />
                  }
                >
                  {m.admin_subscriptions_row_view_user()}
                </MenuItem>
                <MenuItem
                  render={
                    <Link
                      params={{ planId: sub.planId }}
                      to="/admin/access/plans/$planId"
                    />
                  }
                >
                  {m.admin_subscriptions_row_view_plan()}
                </MenuItem>
                <MenuItem onClick={() => void actions.requestEdit(sub)}>
                  {m.admin_users_subs_action_edit()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => void actions.requestReset(sub.id)}>
                  {m.admin_users_subs_action_reset_credentials()}
                </MenuItem>
                <MenuItem
                  onClick={() => void actions.requestRefreshLink(sub.id)}
                >
                  {m.admin_users_subs_action_refresh_link()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void actions.requestDelete(sub.id)}
                >
                  {m.admin_users_subs_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection },
  });

  const selectedCount = Object.keys(rowSelection).length;

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_subscriptions()}</PageHeaderTitle>
        <PageHeaderActions>
          <Button
            loading={isExporting}
            size="sm"
            variant="outline"
            onClick={() => void exportCsv()}
          >
            <DownloadIcon />
            {m.admin_subscriptions_export()}
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <PageToolbar>
        {selectedCount > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            <span className="shrink-0 text-sm font-medium">
              {m.admin_subscriptions_bulk_selected({ count: selectedCount })}
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={bulkMutation.isPending}
                    size="sm"
                    variant="outline"
                  />
                }
              >
                <ListChecksIcon />
                {m.admin_subscriptions_bulk_actions()}
              </MenuTrigger>
              <MenuPopup align="start">
                {BULK_KINDS.map(({ kind, label }) => (
                  <MenuItem key={kind} onClick={() => void requestBulk(kind)}>
                    {label()}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestBulk("delete")}
                >
                  {m.admin_subscriptions_bulk_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Button
              className="shrink-0"
              size="sm"
              variant="ghost"
              onClick={() => setRowSelection({})}
            >
              {m.admin_subscriptions_bulk_clear()}
            </Button>
          </div>
        ) : (
          <SubscriptionToolbar
            hasFilters={hasFilters}
            plans={plans ?? []}
            search={search}
            searchResetToken={searchResetToken}
            onChange={updateSearch}
            onClear={clearFilters}
          />
        )}
      </PageToolbar>

      <PageContent width="flush">
        <p className="px-4 text-xs text-muted-foreground lg:px-6">
          {m.admin_access_snapshot_note()}{" "}
          {m.admin_access_device_not_enforced()}
        </p>

        {filteredPlan ? (
          <p className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground lg:px-6">
            {m.admin_subscriptions_plan_filter_banner({
              name: filteredPlan.name,
            })}
            <Link
              className="underline underline-offset-4"
              params={{ planId: filteredPlan.id }}
              to="/admin/access/plans/$planId"
            >
              {m.admin_subscriptions_plan_filter_open()}
            </Link>
          </p>
        ) : null}

        {isPending ? (
          <TableSkeleton columns={9} rows={8} />
        ) : rows.length > 0 ? (
          <div
            className={isPlaceholderData ? "opacity-60 transition-opacity" : ""}
          >
            <Table variant="pane">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    key={row.id}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="border-t px-4 py-3 lg:px-6">
              <ListPagination
                link={(target) => (
                  <Link
                    from="/admin/access/subscriptions/"
                    to="/admin/access/subscriptions"
                    search={(prev) => ({
                      ...prev,
                      page: target === 1 ? undefined : target,
                    })}
                  />
                )}
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                pageSizes={SUBSCRIPTION_PAGE_SIZES}
                total={total}
                onPageSizeChange={(size) =>
                  updateSearch({
                    pageSize: size === DEFAULT_PAGE_SIZE ? undefined : size,
                  })
                }
              />
            </div>
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ReceiptTextIcon />
              </EmptyMedia>
              <EmptyTitle>
                {hasFilters
                  ? m.admin_subscriptions_empty_filtered()
                  : m.admin_subscriptions_empty_title()}
              </EmptyTitle>
              {hasFilters ? null : (
                <EmptyDescription>
                  {plans && plans.length === 0
                    ? m.admin_subscriptions_empty_need_plans()
                    : m.admin_subscriptions_empty_description()}
                </EmptyDescription>
              )}
            </EmptyHeader>
            {hasFilters ? null : plans && plans.length === 0 ? (
              <Button render={<Link to="/admin/access/plans/new" />}>
                {m.admin_subscriptions_empty_action_plans()}
              </Button>
            ) : (
              <Button render={<Link to="/admin/access/users" />}>
                {m.admin_subscriptions_empty_action_users()}
              </Button>
            )}
          </Empty>
        )}
      </PageContent>
    </div>
  );
}
