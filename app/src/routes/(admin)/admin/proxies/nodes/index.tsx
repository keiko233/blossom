import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, PlusIcon, ServerIcon } from "lucide-react";
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
  deleteNode,
  listNodes,
  NODES_QUERY_KEY,
  type NodeListItem,
} from "@/query/nodes";
import { SERVERS_QUERY_KEY } from "@/query/servers";

export const Route = createFileRoute("/(admin)/admin/proxies/nodes/")({
  component: RouteComponent,
});

// A server's agent is considered online if it heartbeated within this window;
// a node inherits its server's online status.
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function serverOnline(server: NodeListItem["serverSummary"]): boolean {
  if (!server.lastSeenAt) {
    return false;
  }
  return (
    Date.now() - new Date(server.lastSeenAt).getTime() < ONLINE_THRESHOLD_MS
  );
}

const columnHelper = createColumnHelper<NodeListItem>();

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: nodes, isPending } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY }),
    ]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNode({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_nodes_toast_deleted(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_nodes_toast_error(),
      });
    },
  });

  const requestDelete = async (node: NodeListItem) => {
    const confirmed = await Confirm.call({
      title: m.admin_proxies_nodes_delete_title(),
      description: m.admin_proxies_nodes_delete_description(),
      confirmLabel: m.admin_proxies_nodes_action_delete(),
      cancelLabel: m.admin_proxies_nodes_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      deleteMutation.mutate(node.id);
    }
  };

  const openCreate = () => void navigate({ to: "/admin/proxies/nodes/new" });

  const openEdit = (node: NodeListItem) =>
    void navigate({
      to: "/admin/proxies/nodes/$nodeId",
      params: { nodeId: node.id },
    });

  const columns = [
    columnHelper.accessor("name", {
      header: () => m.admin_proxies_nodes_col_name(),
      cell: (info) => {
        const node = info.row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{node.name}</span>
            {node.remark ? (
              <span className="text-xs text-muted-foreground">
                {node.remark}
              </span>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("serverSummary.name", {
      header: () => m.admin_proxies_nodes_col_server(),
      cell: (info) => (
        <span className="text-xs text-muted-foreground">{info.getValue()}</span>
      ),
    }),
    columnHelper.display({
      id: "endpoint",
      header: () => m.admin_proxies_nodes_col_endpoint(),
      cell: (info) => {
        const node = info.row.original;
        return (
          <span className="font-mono text-xs">
            {node.resolvedAddress}:{node.listenPort}
          </span>
        );
      },
    }),
    columnHelper.accessor("protocol", {
      header: () => m.admin_proxies_nodes_col_protocol(),
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
    }),
    columnHelper.display({
      id: "status",
      header: () => m.admin_proxies_nodes_col_status(),
      cell: (info) => {
        const node = info.row.original;
        // Server disabled wins: even if the node is enabled the whole host
        // stops serving because the agent pulls an empty config.
        if (!node.serverSummary.enabled) {
          return (
            <Badge variant="outline">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-muted-foreground/64"
              />
              {m.admin_proxies_nodes_status_server_disabled()}
            </Badge>
          );
        }
        if (!node.enabled) {
          return (
            <Badge variant="outline">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-muted-foreground/64"
              />
              {m.admin_proxies_nodes_status_disabled()}
            </Badge>
          );
        }
        const online = serverOnline(node.serverSummary);
        return (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className={
                online
                  ? "size-1.5 rounded-full bg-emerald-500"
                  : "size-1.5 rounded-full bg-red-500"
              }
            />
            {online
              ? m.admin_proxies_nodes_status_online()
              : m.admin_proxies_nodes_status_offline()}
          </Badge>
        );
      },
    }),
    columnHelper.accessor("tags", {
      header: () => m.admin_proxies_nodes_col_tags(),
      cell: (info) => {
        const tags = info.getValue();
        if (!tags.length) {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" size="sm">
                {tag}
              </Badge>
            ))}
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const node = info.row.original;
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
                <MenuItem onClick={() => openEdit(node)}>
                  {m.admin_proxies_nodes_action_edit()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestDelete(node)}
                >
                  {m.admin_proxies_nodes_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: nodes ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-semibold">
          {m.admin_nav_proxies_item_nodes()}
        </h1>
        <Button onClick={openCreate}>
          <PlusIcon />
          {m.admin_proxies_nodes_add()}
        </Button>
      </div>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : nodes && nodes.length > 0 ? (
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
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>{m.admin_proxies_nodes_empty_title()}</EmptyTitle>
          </EmptyHeader>
          <Button onClick={openCreate}>
            <PlusIcon />
            {m.admin_proxies_nodes_add()}
          </Button>
        </Empty>
      )}
    </div>
  );
}
