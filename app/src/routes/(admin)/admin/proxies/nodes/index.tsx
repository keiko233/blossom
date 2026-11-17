import { deriveNodeHealth } from "@blossom/domain/agent-status";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, PlusIcon, ServerIcon } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
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
import {
  filterNodesByServer,
  serverContextSearchSchema,
} from "@/lib/server-node-context";
import { m } from "@/paraglide/messages";
import {
  deleteNode,
  listNodes,
  NODES_QUERY_KEY,
  type NodeListItem,
} from "@/query/nodes";
import { listServers, SERVERS_QUERY_KEY } from "@/query/servers";

export const Route = createFileRoute("/(admin)/admin/proxies/nodes/")({
  validateSearch: serverContextSearchSchema,
  component: RouteComponent,
});

const columnHelper = createColumnHelper<NodeListItem>();

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { serverId } = Route.useSearch();

  const { data: allNodes, isPending } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
    refetchInterval: 15_000,
  });
  // Only needed to name (or recognise) the server a filtered view is for.
  const { data: servers } = useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => listServers(),
    enabled: Boolean(serverId),
  });
  const filterServer = serverId
    ? servers?.find((server) => server.id === serverId)
    : undefined;
  // `servers` is undefined until it loads; only then can a missing server be
  // told apart from one that is still loading.
  const filterServerMissing =
    Boolean(serverId) && servers !== undefined && !filterServer;
  const nodes = useMemo(
    () => allNodes && filterNodesByServer(allNodes, serverId),
    [allNodes, serverId],
  );

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
    await Confirm.call({
      title: m.admin_proxies_nodes_delete_title(),
      description: m.admin_proxies_nodes_delete_description(),
      confirmLabel: m.admin_proxies_nodes_action_delete(),
      cancelLabel: m.admin_proxies_nodes_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(node.id),
    });
  };

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
        const health = deriveNodeHealth(
          node.id,
          node.enabled,
          node.serverSummary,
        );
        const label = {
          server_disabled: m.admin_proxies_nodes_status_server_disabled(),
          disabled: m.admin_proxies_nodes_status_disabled(),
          agent_offline: m.admin_proxies_nodes_status_agent_offline(),
          runtime_error: m.admin_proxies_nodes_status_runtime_error(),
          config_error: m.admin_proxies_nodes_status_config_error(),
          serving_stale: m.admin_proxies_nodes_status_serving_stale(),
          serving: m.admin_proxies_nodes_status_serving(),
          idle: m.admin_proxies_nodes_status_idle(),
          unknown: m.admin_proxies_nodes_status_unknown(),
        }[health];
        const dotClass =
          health === "serving"
            ? "bg-emerald-500"
            : health === "serving_stale" ||
                health === "idle" ||
                health === "unknown"
              ? "bg-amber-500"
              : "bg-red-500";
        return (
          <div className="flex max-w-80 flex-col items-start gap-1">
            <Badge
              variant="outline"
              title={node.serverSummary.lastErrorMessage ?? undefined}
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${dotClass}`}
              />
              {label}
            </Badge>
            {node.serverSummary.lastErrorMessage &&
            (!node.serverSummary.lastErrorNodeId ||
              node.serverSummary.lastErrorNodeId === node.id) &&
            ["config_error", "serving_stale", "runtime_error"].includes(
              health,
            ) ? (
              <span className="line-clamp-2 text-xs text-destructive">
                {node.serverSummary.lastErrorMessage}
              </span>
            ) : null}
          </div>
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
                render={
                  <Button
                    loading={
                      deleteMutation.isPending &&
                      deleteMutation.variables === node.id
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
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_proxies_item_nodes()}</PageHeaderTitle>

        <Button
          render={
            <Link
              to="/admin/proxies/nodes/new"
              search={filterServer ? { serverId: filterServer.id } : {}}
            />
          }
        >
          <PlusIcon />
          {m.admin_proxies_nodes_add()}
        </Button>
      </PageHeader>

      {serverId ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
          {filterServer ? (
            <span>
              {m.admin_proxies_nodes_filter_server({
                server: filterServer.name,
              })}
            </span>
          ) : filterServerMissing ? (
            <span className="text-destructive">
              {m.admin_proxies_nodes_filter_server_missing()}
            </span>
          ) : null}
          <Link
            to="/admin/proxies/nodes"
            className="text-xs underline underline-offset-4"
          >
            {m.admin_proxies_nodes_filter_clear()}
          </Link>
        </div>
      ) : null}

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
      ) : filterServerMissing ? null : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>
              {filterServer
                ? m.admin_proxies_nodes_empty_for_server()
                : m.admin_proxies_nodes_empty_title()}
            </EmptyTitle>
          </EmptyHeader>

          <Button
            render={
              <Link
                to="/admin/proxies/nodes/new"
                search={filterServer ? { serverId: filterServer.id } : {}}
              />
            }
          >
            <PlusIcon />
            {m.admin_proxies_nodes_add()}
          </Button>
        </Empty>
      )}

      {nodes && nodes.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_nodes_status_note()}
        </p>
      ) : null}
    </div>
  );
}
