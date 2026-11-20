import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, FolderIcon, PlusIcon } from "lucide-react";
import type React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
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
  getGroupImpact,
  type GroupListItem,
  GROUPS_QUERY_KEY,
  listGroups,
} from "@/query/groups";
import { listNodes, NODES_QUERY_KEY } from "@/query/nodes";

export const Route = createFileRoute("/(admin)/admin/access/groups/")({
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

  const { data: nodes } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
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
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_groups_toast_error(),
      });
    },
  });

  const requestDelete = async (group: GroupListItem) => {
    // Advisory read: if it fails the confirmation still works, and the server
    // decides the outcome either way.
    const impact = await getGroupImpact({ data: { id: group.id } }).catch(
      () => undefined,
    );
    const impactText = !impact
      ? ""
      : impact.plans.length === 0
        ? m.admin_access_group_delete_unused()
        : m.admin_access_group_delete_used({
            plans: impact.plans.map((plan) => plan.name).join(", "),
            subscriptions: impact.subscriptionCount,
          });
    await Confirm.call({
      title: m.admin_proxies_groups_delete_title(),
      description: [m.admin_proxies_groups_delete_description(), impactText]
        .filter(Boolean)
        .join(" "),
      confirmLabel: m.admin_proxies_groups_action_delete(),
      cancelLabel: m.admin_proxies_groups_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(group.id),
    });
  };

  const openEdit = (group: GroupListItem) =>
    void navigate({
      to: "/admin/access/groups/$groupId",
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
      cell: (info) => (
        <div className="flex items-center gap-2">
          <Badge variant="outline">{info.getValue()}</Badge>
          {info.getValue() === 0 ? (
            <span className="text-xs text-muted-foreground">
              {m.admin_access_group_list_empty()}
            </span>
          ) : null}
        </div>
      ),
    }),
    columnHelper.accessor("planCount", {
      header: () => m.admin_proxies_groups_col_plans(),
      cell: (info) => (
        <div className="flex items-center gap-2">
          <Badge variant="outline">{info.getValue()}</Badge>
          {info.getValue() === 0 ? (
            <span className="text-xs text-muted-foreground">
              {m.admin_access_group_list_unused()}
            </span>
          ) : null}
        </div>
      ),
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
                render={
                  <Button
                    loading={
                      deleteMutation.isPending &&
                      deleteMutation.variables === group.id
                    }
                    size="icon"
                    variant="ghost"
                  />
                }
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
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_proxies_item_groups()}</PageHeaderTitle>
        <Button render={<Link to="/admin/access/groups/new" />}>
          <PlusIcon />
          {m.admin_proxies_groups_add()}
        </Button>
      </PageHeader>

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
            <EmptyDescription>
              {nodes && nodes.length === 0
                ? m.admin_access_groups_empty_need_nodes()
                : m.admin_access_groups_empty_description()}
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex flex-wrap justify-center gap-2">
            {nodes && nodes.length === 0 ? (
              <Button variant="outline" render={<Link to="/admin/servers" />}>
                {m.admin_access_create_node()}
              </Button>
            ) : null}
            <Button render={<Link to="/admin/access/groups/new" />}>
              <PlusIcon />
              {m.admin_proxies_groups_add()}
            </Button>
          </div>
        </Empty>
      )}
    </div>
  );
}
