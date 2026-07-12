import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, FolderIcon, PlusIcon } from "lucide-react";
import type React from "react";

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
import { m } from "@/paraglide/messages";
import {
  deleteGroup,
  type GroupListItem,
  GROUPS_QUERY_KEY,
  listGroups,
} from "@/query/groups";

export const Route = createFileRoute("/(admin)/admin/proxies/groups/")({
  component: RouteComponent,
});

const columnHelper = createColumnHelper<GroupListItem>();

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: groups, isPending } = useQuery({
    queryKey: GROUPS_QUERY_KEY,
    queryFn: () => listGroups(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteGroup({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_proxies_groups_toast_deleted(),
      });
    },
  });

  const requestDelete = async (group: GroupListItem) => {
    const confirmed = await Confirm.call({
      title: m.admin_proxies_groups_delete_title(),
      description: m.admin_proxies_groups_delete_description(),
      confirmLabel: m.admin_proxies_groups_action_delete(),
      cancelLabel: m.admin_proxies_groups_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      deleteMutation.mutate(group.id);
    }
  };

  const openCreate = () => void navigate({ to: "/admin/proxies/groups/new" });

  const openEdit = (group: GroupListItem) =>
    void navigate({
      to: "/admin/proxies/groups/$groupId",
      params: { groupId: group.id },
    });

  const columns = [
    columnHelper.accessor("name", {
      header: () => m.admin_proxies_groups_col_name(),
      cell: (info) => {
        const group = info.row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{group.name}</span>
            {group.remark ? (
              <span className="text-xs text-muted-foreground">
                {group.remark}
              </span>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("nodeCount", {
      header: () => m.admin_proxies_groups_col_nodes(),
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
    }),
    columnHelper.accessor("planCount", {
      header: () => m.admin_proxies_groups_col_plans(),
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
    }),
    columnHelper.accessor("createdAt", {
      header: () => m.admin_proxies_groups_col_created(),
      cell: (info) => (
        <span className="text-muted-foreground">
          {new Date(info.getValue()).toLocaleDateString()}
        </span>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const group = info.row.original;
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
                <MenuItem onClick={() => openEdit(group)}>
                  {m.admin_proxies_groups_action_edit()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestDelete(group)}
                >
                  {m.admin_proxies_groups_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: groups ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-semibold">
          {m.admin_nav_proxies_item_groups()}
        </h1>
        <Button onClick={openCreate}>
          <PlusIcon />
          {m.admin_proxies_groups_add()}
        </Button>
      </div>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : groups && groups.length > 0 ? (
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
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>{m.admin_proxies_groups_empty_title()}</EmptyTitle>
          </EmptyHeader>
          <Button onClick={openCreate}>
            <PlusIcon />
            {m.admin_proxies_groups_add()}
          </Button>
        </Empty>
      )}
    </div>
  );
}
