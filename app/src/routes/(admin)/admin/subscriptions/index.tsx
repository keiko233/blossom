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
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
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
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { downloadCsv } from "@/lib/download-csv";
import { formatDate } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import { getEffectiveSubscriptionStatus } from "@/lib/subscription-helpers";
import {
  DEFAULT_PAGE_SIZE,
  searchToFilter,
  type SubscriptionsSearch,
  subscriptionsSearchSchema,
} from "@/lib/subscription-search";
import {
  type BulkSubscriptionActionInput,
  SUBSCRIPTION_PAGE_SIZES,
  type subscriptionSortSchema,
} from "@/orpc/plan/schema";
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

export const Route = createFileRoute("/(admin)/admin/subscriptions/")({
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
            to="/admin/users/$userId"
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
      cell: (info) => <span className="font-medium">{info.getValue()}</span>,
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
        <SubscriptionQuotaUsage
          trafficQuotaBytes={row.original.trafficQuotaBytes}
          trafficUsedBytes={row.original.trafficUsedBytes}
        />
      ),
    }),
    columnHelper.accessor("deviceLimit", {
      header: () => m.admin_subscriptions_col_devices(),
      cell: (info) =>
        info.getValue() === 0 ? (
          <span className="text-xs text-muted-foreground">
            {m.admin_subscriptions_devices_unlimited()}
          </span>
        ) : (
          info.getValue()
        ),
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
                      to="/admin/users/$userId"
                    />
                  }
                >
                  {m.admin_subscriptions_row_view_user()}
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
    <div className="flex flex-col gap-4 p-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_subscriptions()}</PageHeaderTitle>
        <Button
          loading={isExporting}
          variant="outline"
          onClick={() => void exportCsv()}
        >
          <DownloadIcon />
          {m.admin_subscriptions_export()}
        </Button>
      </PageHeader>

      <SubscriptionToolbar
        hasFilters={hasFilters}
        plans={plans ?? []}
        search={search}
        searchResetToken={searchResetToken}
        onChange={updateSearch}
        onClear={clearFilters}
      />

      {selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/32 px-3 py-2">
          <span className="text-sm font-medium">
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
          <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
            {m.admin_subscriptions_bulk_clear()}
          </Button>
        </div>
      ) : null}

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length > 0 ? (
        <div
          className={isPlaceholderData ? "opacity-60 transition-opacity" : ""}
        >
          <Table>
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

          <ListPagination
            link={(target) => (
              <Link
                from="/admin/subscriptions/"
                to="/admin/subscriptions"
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
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
