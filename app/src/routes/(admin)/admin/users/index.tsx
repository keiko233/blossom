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
  PlusIcon,
  UsersIcon,
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { downloadCsv } from "@/lib/download-csv";
import { formatDate } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import { DEFAULT_PAGE_SIZE } from "@/lib/subscription-search";
import {
  searchToUserFilter,
  type UsersSearch,
  usersSearchSchema,
} from "@/lib/user-search";
import {
  type BulkUserActionInput,
  USER_PAGE_SIZES,
  type userSortSchema,
} from "@/orpc/user/schema";
import { m } from "@/paraglide/messages";
import {
  bulkUpdateUsers,
  createUser,
  exportUsersCsv,
  listUsers,
  type UserListItem,
  USERS_QUERY_KEY,
} from "@/query/users";

import { BanUserDialog } from "./_modules/ban-user-dialog";
import { CreateUserDialog } from "./_modules/create-user-dialog";
import {
  toastSignInLinkStatus,
  useUserActions,
} from "./_modules/use-user-actions";
import { UserToolbar } from "./_modules/user-toolbar";

export const Route = createFileRoute("/(admin)/admin/users/")({
  validateSearch: usersSearchSchema,
  component: RouteComponent,
});

const columnHelper = createColumnHelper<UserListItem>();

type SortColumn = z.infer<typeof userSortSchema>;

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const routeNavigate = Route.useNavigate();
  const { user: currentUser } = Route.useRouteContext();
  const queryClient = useQueryClient();

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [searchResetToken, setSearchResetToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const page = search.page ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const filter = searchToUserFilter(search);
  const listInput = { ...filter, page, pageSize };

  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [...USERS_QUERY_KEY, "list", listInput],
    queryFn: () => listUsers({ data: listInput }),
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  // Deleting the last rows of the final page leaves it empty: step back.
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

  // Selection is per view: it must not leak across pages or filters.
  const viewKey = JSON.stringify(listInput);
  useEffect(() => {
    setRowSelection({});
  }, [viewKey]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });

  const actions = useUserActions(invalidate);

  const openDetail = (user: UserListItem) =>
    void routeNavigate({
      to: "/admin/users/$userId",
      params: { userId: user.id },
    });

  const updateSearch = (patch: Partial<UsersSearch>) => {
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
    search.role !== undefined ||
    search.status !== undefined ||
    search.subscription !== undefined;

  const toggleSort = (column: SortColumn) => {
    const active = (search.sort ?? "createdAt") === column;
    const dir = search.dir ?? "desc";
    updateSearch({
      sort: column,
      // Text columns read naturally A→Z first; dates newest first.
      dir: active
        ? dir === "asc"
          ? "desc"
          : "asc"
        : column === "createdAt"
          ? "desc"
          : "asc",
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

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createUser>[0]["data"]) =>
      createUser({ data: input }),
    onSuccess: async (result) => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_created(),
      });
      if (result.subscriptionFailed) {
        toastManager.add({
          type: "warning",
          title: m.admin_users_toast_created_subscription_failed(),
        });
      }
      if (result.signInLink) {
        toastSignInLinkStatus(result.signInLink);
      }
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_users_toast_error() });
    },
  });

  const bulkMutation = useMutation({
    mutationFn: (input: BulkUserActionInput) =>
      bulkUpdateUsers({
        data: { ids: Object.keys(rowSelection), action: input },
      }),
    onSuccess: async (result) => {
      setRowSelection({});
      await invalidate();
      toastManager.add({
        type: result.failed.length > 0 ? "warning" : "success",
        title: m.admin_users_bulk_toast_title(),
        description: m.admin_users_bulk_toast_result({
          succeeded: result.succeeded,
          failed: result.failed.length,
          skipped: result.skipped.length,
        }),
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_users_toast_error() });
    },
  });

  const selectedCount = Object.keys(rowSelection).length;

  const requestBulkBan = async () => {
    await BanUserDialog.call({
      count: selectedCount,
      onBan: (params) => bulkMutation.mutateAsync({ type: "ban", ...params }),
    });
  };

  const requestBulkConfirm = async (
    action: BulkUserActionInput,
    labels: { title: string; description: string; confirm: string },
  ) => {
    await Confirm.call({
      title: labels.title,
      description: labels.description,
      confirmLabel: labels.confirm,
      cancelLabel: m.admin_users_form_cancel(),
      destructive: action.type === "delete",
      onConfirm: () => bulkMutation.mutateAsync(action),
    });
  };

  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const result = await exportUsersCsv({ data: filter });
      downloadCsv(
        `users-${new Date().toISOString().slice(0, 10)}.csv`,
        result.csv,
      );
      toastManager.add({
        type: result.truncated ? "warning" : "success",
        title: result.truncated
          ? m.admin_users_export_truncated({ count: result.count })
          : m.admin_users_export_done({ count: result.count }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_users_export_error(),
      });
    } finally {
      setIsExporting(false);
    }
  };

  const columns = [
    columnHelper.display({
      id: "select",
      header: ({ table }) => (
        <Checkbox
          aria-label={m.admin_users_select_all()}
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onCheckedChange={(checked) =>
            table.toggleAllPageRowsSelected(checked)
          }
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={m.admin_users_select_row()}
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onCheckedChange={(checked) => row.toggleSelected(checked)}
        />
      ),
    }),
    columnHelper.accessor("name", {
      header: () => sortHeader("name", m.admin_users_col_user()),
      cell: (info) => {
        const user = info.row.original;
        return (
          <Link
            className="flex items-center gap-2.5"
            params={{ userId: user.id }}
            to="/admin/users/$userId"
          >
            <Avatar className="size-8">
              {user.image ? <AvatarImage src={user.image} /> : null}
              <AvatarFallback>
                {user.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium hover:underline">{user.name}</span>
          </Link>
        );
      },
    }),
    columnHelper.accessor("email", {
      header: () => sortHeader("email", m.admin_users_col_email()),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor("role", {
      header: () => m.admin_users_col_role(),
      cell: (info) =>
        info.getValue() === "admin" ? (
          <Badge>{m.admin_users_role_admin()}</Badge>
        ) : (
          <Badge variant="outline">{m.admin_users_role_user()}</Badge>
        ),
    }),
    columnHelper.accessor("banned", {
      header: () => m.admin_users_col_status(),
      cell: (info) =>
        info.getValue() ? (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-destructive"
            />
            {m.admin_users_status_banned()}
          </Badge>
        ) : (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-emerald-500"
            />
            {m.admin_users_status_active()}
          </Badge>
        ),
    }),
    columnHelper.accessor("subscriptionCount", {
      header: () => m.admin_users_col_subscriptions(),
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
    }),
    columnHelper.accessor("createdAt", {
      header: () => sortHeader("createdAt", m.admin_users_col_created()),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">
          {formatDate(info.getValue())}
        </span>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const user = info.row.original;
        const isSelf = user.id === currentUser.id;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={actions.pendingUserId === user.id}
                    size="icon"
                    variant="ghost"
                  />
                }
                aria-label="Actions"
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openDetail(user)}>
                  {m.admin_users_action_view()}
                </MenuItem>
                <MenuItem onClick={() => void actions.requestEdit(user)}>
                  {m.admin_users_action_edit()}
                </MenuItem>
                {isSelf ? null : (
                  <>
                    <MenuItem onClick={() => actions.toggleRole(user)}>
                      {user.role === "admin"
                        ? m.admin_users_action_make_user()
                        : m.admin_users_action_make_admin()}
                    </MenuItem>
                    {user.role === "admin" ? null : (
                      <MenuItem
                        onClick={() => void actions.requestImpersonate(user)}
                      >
                        {m.admin_users_action_impersonate()}
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    {user.banned ? (
                      <MenuItem onClick={() => actions.unban(user)}>
                        {m.admin_users_action_unban()}
                      </MenuItem>
                    ) : (
                      <MenuItem
                        variant="destructive"
                        onClick={() => void actions.requestBan(user)}
                      >
                        {m.admin_users_action_ban()}
                      </MenuItem>
                    )}
                    <MenuItem
                      variant="destructive"
                      onClick={() => void actions.requestDelete(user)}
                    >
                      {m.admin_users_action_delete()}
                    </MenuItem>
                  </>
                )}
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
    // The calling admin can't be a bulk target; the server skips it as well.
    enableRowSelection: (row) => row.original.id !== currentUser.id,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection },
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_users()}</PageHeaderTitle>
        <div className="flex items-center gap-2">
          <Button
            loading={isExporting}
            variant="outline"
            onClick={() => void exportCsv()}
          >
            <DownloadIcon />
            {m.admin_users_export()}
          </Button>
          <Button
            onClick={() =>
              void CreateUserDialog.call({
                onCreate: (input) => createMutation.mutateAsync(input),
              })
            }
          >
            <PlusIcon />
            {m.admin_users_create()}
          </Button>
        </div>
      </PageHeader>

      <UserToolbar
        hasFilters={hasFilters}
        search={search}
        searchResetToken={searchResetToken}
        onChange={updateSearch}
        onClear={clearFilters}
      />

      {selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/32 px-3 py-2">
          <span className="text-sm font-medium">
            {m.admin_users_bulk_selected({ count: selectedCount })}
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
              {m.admin_users_bulk_actions()}
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuItem
                onClick={() =>
                  void requestBulkConfirm(
                    { type: "setRole", role: "admin" },
                    {
                      title: m.admin_users_bulk_role_admin_title(),
                      description: m.admin_users_bulk_role_admin_description({
                        count: selectedCount,
                      }),
                      confirm: m.admin_users_bulk_confirm(),
                    },
                  )
                }
              >
                {m.admin_users_bulk_role_admin()}
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void requestBulkConfirm(
                    { type: "setRole", role: "user" },
                    {
                      title: m.admin_users_bulk_role_user_title(),
                      description: m.admin_users_bulk_role_user_description({
                        count: selectedCount,
                      }),
                      confirm: m.admin_users_bulk_confirm(),
                    },
                  )
                }
              >
                {m.admin_users_bulk_role_user()}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onClick={() =>
                  void requestBulkConfirm(
                    { type: "unban" },
                    {
                      title: m.admin_users_bulk_unban_title(),
                      description: m.admin_users_bulk_unban_description({
                        count: selectedCount,
                      }),
                      confirm: m.admin_users_bulk_confirm(),
                    },
                  )
                }
              >
                {m.admin_users_bulk_unban()}
              </MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() => void requestBulkBan()}
              >
                {m.admin_users_bulk_ban()}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void requestBulkConfirm(
                    { type: "delete" },
                    {
                      title: m.admin_users_bulk_delete_title(),
                      description: m.admin_users_bulk_delete_description({
                        count: selectedCount,
                      }),
                      confirm: m.admin_users_bulk_delete_confirm(),
                    },
                  )
                }
              >
                {m.admin_users_bulk_delete()}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
            {m.admin_users_bulk_clear()}
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
                from="/admin/users/"
                to="/admin/users"
                search={(prev) => ({
                  ...prev,
                  page: target === 1 ? undefined : target,
                })}
              />
            )}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            pageSizes={USER_PAGE_SIZES}
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
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>
              {hasFilters
                ? m.admin_users_empty_filtered()
                : m.admin_users_empty_title()}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
