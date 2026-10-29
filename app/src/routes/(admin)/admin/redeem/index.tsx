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
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, PlusIcon, TicketIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import type { z } from "zod";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { ListPagination } from "@/components/list-pagination";
import { SortHeader } from "@/components/sort-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
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
import { formatDateTime } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import { totalRedeemUses } from "@/lib/redeem-batch";
import {
  type RedeemSearch,
  redeemSearchSchema,
  searchToRedeemFilter,
} from "@/lib/redeem-search";
import { DEFAULT_PAGE_SIZE } from "@/lib/subscription-search";
import {
  REDEEM_PAGE_SIZES,
  type redeemBatchSortSchema,
} from "@/orpc/redeem/schema";
import { m } from "@/paraglide/messages";
import {
  deleteRedeemBatch,
  listRedeemBatches,
  type RedeemBatchListItem,
  REDEEM_QUERY_KEY,
  updateRedeemBatch,
} from "@/query/redeem";

import { BatchToolbar } from "./_modules/batch-toolbar";
import { CreateBatchDialog } from "./_modules/create-batch-dialog";
import {
  durationLabel,
  MODE_LABELS,
  RedeemStatusBadge,
} from "./_modules/redeem-labels";

export const Route = createFileRoute("/(admin)/admin/redeem/")({
  validateSearch: redeemSearchSchema,
  component: RouteComponent,
});

const columnHelper = createColumnHelper<RedeemBatchListItem>();

type SortColumn = z.infer<typeof redeemBatchSortSchema>;

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const routeNavigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const [searchResetToken, setSearchResetToken] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const page = search.page ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const filter = searchToRedeemFilter(search);
  const listInput = { ...filter, page, pageSize };

  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [...REDEEM_QUERY_KEY, "list", listInput],
    queryFn: () => listRedeemBatches({ data: listInput }),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  // Deleting the last row of the final page leaves it empty: step back.
  useEffect(() => {
    if (data && page > pageCount) {
      void routeNavigate({
        search: (prev) => ({
          ...prev,
          page: pageCount === 1 ? undefined : pageCount,
        }),
        replace: true,
      });
    }
  }, [data, page, pageCount, routeNavigate]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: REDEEM_QUERY_KEY });

  const updateSearch = (patch: Partial<RedeemSearch>) => {
    void routeNavigate({
      search: (prev) => ({ ...prev, ...patch, page: undefined }),
      replace: true,
    });
  };

  const clearFilters = () => {
    setSearchResetToken((token) => token + 1);
    void routeNavigate({
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
    search.plan !== undefined ||
    search.mode !== undefined ||
    search.status !== undefined;

  const toggleSort = (column: SortColumn) => {
    const active = (search.sort ?? "createdAt") === column;
    const dir = search.dir ?? "desc";
    updateSearch({
      sort: column,
      // Names read naturally A→Z first; dates newest first.
      dir: active
        ? dir === "asc"
          ? "desc"
          : "asc"
        : column === "name"
          ? "asc"
          : "desc",
    });
  };

  const sortHeader = (column: SortColumn, label: string) => (
    <SortHeader
      active={(search.sort ?? "createdAt") === column}
      dir={search.dir ?? "desc"}
      label={label}
      onClick={() => toggleSort(column)}
    />
  );

  const toggleMutation = useMutation({
    mutationFn: (batch: RedeemBatchListItem) =>
      updateRedeemBatch({ data: { id: batch.id, disabled: !batch.disabled } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_redeem_toast_updated(),
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_redeem_toast_error() });
    },
  });

  const requestDelete = async (batch: RedeemBatchListItem) => {
    await Confirm.call({
      title: m.admin_redeem_delete_title(),
      description: m.admin_redeem_delete_description({ name: batch.name }),
      confirmLabel: m.admin_redeem_delete_confirm(),
      cancelLabel: m.admin_redeem_cancel(),
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteRedeemBatch({ data: { id: batch.id } });
          await invalidate();
          toastManager.add({
            type: "success",
            title: m.admin_redeem_toast_deleted(),
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: m.admin_redeem_toast_error(),
          });
          throw error;
        }
      },
    });
  };

  const columns = [
    columnHelper.accessor("name", {
      header: () => sortHeader("name", m.admin_redeem_col_name()),
      cell: (info) => (
        <Link
          className="font-medium hover:underline"
          params={{ batchId: info.row.original.id }}
          to="/admin/redeem/$batchId"
        >
          {info.getValue()}
        </Link>
      ),
    }),
    columnHelper.accessor("planName", {
      header: () => m.admin_redeem_col_plan(),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("mode", {
      header: () => m.admin_redeem_col_mode(),
      cell: (info) => (
        <Badge variant="outline">{MODE_LABELS[info.getValue()]()}</Badge>
      ),
    }),
    columnHelper.display({
      id: "duration",
      header: () => m.admin_redeem_col_duration(),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {durationLabel(
            info.row.original.durationDays,
            info.row.original.planDurationDays,
          )}
        </span>
      ),
    }),
    columnHelper.accessor("codeCount", {
      header: () => m.admin_redeem_col_codes(),
      cell: (info) => info.getValue(),
    }),
    columnHelper.display({
      id: "uses",
      header: () => m.admin_redeem_col_uses(),
      cell: (info) => {
        const batch = info.row.original;
        return (
          <span className="tabular-nums">
            {batch.redeemed} /{" "}
            {totalRedeemUses(batch.codeCount, batch.maxRedemptionsPerCode)}
          </span>
        );
      },
    }),
    columnHelper.accessor("expiresAt", {
      header: () => sortHeader("expiresAt", m.admin_redeem_col_expires()),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {info.getValue()
            ? formatDateTime(info.getValue()!)
            : m.admin_redeem_never()}
        </span>
      ),
    }),
    columnHelper.accessor("status", {
      header: () => m.admin_redeem_col_status(),
      cell: (info) => <RedeemStatusBadge status={info.getValue()} />,
    }),
    columnHelper.accessor("createdByName", {
      header: () => m.admin_redeem_col_created_by(),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {info.getValue() ?? m.admin_redeem_unknown_user()}
        </span>
      ),
    }),
    columnHelper.accessor("createdAt", {
      header: () => sortHeader("createdAt", m.admin_redeem_col_created()),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {formatDateTime(info.getValue())}
        </span>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const batch = info.row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={<Button size="icon" variant="ghost" />}
                aria-label="Actions"
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  render={
                    <Link
                      params={{ batchId: batch.id }}
                      to="/admin/redeem/$batchId"
                    />
                  }
                >
                  {m.admin_redeem_action_view()}
                </MenuItem>
                <MenuItem onClick={() => toggleMutation.mutate(batch)}>
                  {batch.disabled
                    ? m.admin_redeem_action_enable()
                    : m.admin_redeem_action_disable()}
                </MenuItem>
                {batch.redeemed === 0 ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      variant="destructive"
                      onClick={() => void requestDelete(batch)}
                    >
                      {m.admin_redeem_action_delete()}
                    </MenuItem>
                  </>
                ) : null}
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
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_redeem()}</PageHeaderTitle>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          {m.admin_redeem_create()}
        </Button>
      </PageHeader>

      <BatchToolbar
        hasFilters={hasFilters}
        search={search}
        searchResetToken={searchResetToken}
        onChange={updateSearch}
        onClear={clearFilters}
      />

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
                <TableRow key={row.id}>
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
                from="/admin/redeem/"
                to="/admin/redeem"
                search={(prev) => ({
                  ...prev,
                  page: target === 1 ? undefined : target,
                })}
              />
            )}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            pageSizes={REDEEM_PAGE_SIZES}
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
              <TicketIcon />
            </EmptyMedia>
            <EmptyTitle>
              {hasFilters
                ? m.admin_redeem_empty_filtered()
                : m.admin_redeem_empty_title()}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      <CreateBatchDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
