import { deriveServerHealth } from "@blossom/domain/agent-status";
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
import { useState } from "react";

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
import { m } from "@/paraglide/messages";
import {
  deleteServer,
  listServers,
  regenerateServerToken,
  SERVERS_QUERY_KEY,
  type ServerListItem,
} from "@/query/servers";

import { TokenRevealDialog } from "./_modules/token-reveal-dialog";

export const Route = createFileRoute("/(admin)/admin/proxies/servers/")({
  component: RouteComponent,
});

const columnHelper = createColumnHelper<ServerListItem>();

function updateStateLabel(state: string): string | null {
  switch (state) {
    case "up_to_date":
      return m.admin_proxies_servers_update_up_to_date();
    case "checking":
    case "downloading":
    case "verifying":
    case "applying":
    case "restarting":
      return m.admin_proxies_servers_update_in_progress();
    case "failed":
      return m.admin_proxies_servers_update_failed();
    case "disabled":
      return m.admin_proxies_servers_update_disabled();
    default:
      return null;
  }
}

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [copyingServerId, setCopyingServerId] = useState<string | null>(null);

  const { data: servers, isPending } = useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => listServers(),
    refetchInterval: 15_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteServer({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_toast_deleted(),
      });
    },
    onError: (error: unknown) => {
      // The CRUD layer throws a clear "still has nodes" message; FK RESTRICT
      // beneath makes that robust. Surface it as a toast, not a generic error.
      const message = error instanceof Error ? error.message : String(error);
      toastManager.add({
        type: "error",
        title:
          message.includes("node") || message.includes("节点")
            ? m.admin_proxies_servers_toast_blocked()
            : m.admin_proxies_servers_toast_error(),
      });
    },
  });

  const regenMutation = useMutation({
    mutationFn: (id: string) => regenerateServerToken({ data: { id } }),
    onSuccess: async (result) => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_toast_token_reset(),
      });
      await TokenRevealDialog.call({ token: result.token });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_toast_error(),
      });
    },
  });

  const requestDelete = async (server: ServerListItem) => {
    if (server.nodeCount > 0) {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_toast_blocked(),
      });
      return;
    }

    await Confirm.call({
      title: m.admin_proxies_servers_delete_title(),
      description: m.admin_proxies_servers_delete_description(),
      confirmLabel: m.admin_proxies_servers_action_delete(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(server.id),
    });
  };

  const openEdit = (server: ServerListItem) =>
    void navigate({
      to: "/admin/proxies/servers/$serverId",
      params: { serverId: server.id },
    });

  const openNodes = (server: ServerListItem) =>
    void navigate({
      to: "/admin/proxies/nodes",
      search: { serverId: server.id },
    });

  const addNode = (server: ServerListItem) =>
    void navigate({
      to: "/admin/proxies/nodes/new",
      search: { serverId: server.id },
    });

  const copyAgentInfo = async (server: ServerListItem) => {
    setCopyingServerId(server.id);
    const info = JSON.stringify(
      {
        serverId: server.id,
        address: server.address,
        ...(server.agentTokenPrefix
          ? { tokenPrefix: server.agentTokenPrefix }
          : {}),
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(info);
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_toast_copied(),
      });
    } finally {
      setCopyingServerId(null);
    }
  };

  const columns = [
    columnHelper.accessor("name", {
      header: () => m.admin_proxies_servers_col_name(),
      cell: (info) => {
        const server = info.row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{server.name}</span>
            {server.remark ? (
              <span className="text-xs text-muted-foreground">
                {server.remark}
              </span>
            ) : null}
            <span className="font-mono text-xs text-muted-foreground">
              {[
                server.agentTokenPrefix,
                server.agentVersion && `v${server.agentVersion}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        );
      },
    }),
    columnHelper.accessor("address", {
      header: () => m.admin_proxies_servers_col_address(),
      cell: (info) => (
        <span className="font-mono text-xs">{info.getValue()}</span>
      ),
    }),
    columnHelper.display({
      id: "versions",
      header: () => m.admin_proxies_servers_col_version(),
      cell: (info) => {
        const server = info.row.original;
        const agentState = updateStateLabel(server.agentUpdateState);
        const singBoxState = updateStateLabel(server.singBoxUpdateState);
        return (
          <div className="flex max-w-72 flex-col gap-1 text-xs">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground">
                {m.admin_proxies_servers_versions_agent()}
              </span>
              <span className="font-mono">
                {server.agentVersion ? `v${server.agentVersion}` : "—"}
              </span>
              {server.desiredAgentVersion ? (
                <span className="font-mono text-muted-foreground">
                  → {server.desiredAgentVersion}
                </span>
              ) : null}
              {agentState ? (
                <Badge
                  variant="outline"
                  title={server.agentUpdateError ?? undefined}
                >
                  {agentState}
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground">
                {m.admin_proxies_servers_versions_sing_box()}
              </span>
              <span className="font-mono">
                {server.singBoxVersion ? `v${server.singBoxVersion}` : "—"}
              </span>
              {server.desiredSingBoxVersion ? (
                <span className="font-mono text-muted-foreground">
                  → {server.desiredSingBoxVersion}
                </span>
              ) : null}
              {singBoxState ? (
                <Badge
                  variant="outline"
                  title={server.singBoxUpdateError ?? undefined}
                >
                  {singBoxState}
                </Badge>
              ) : null}
            </div>
          </div>
        );
      },
    }),
    columnHelper.accessor("nodeCount", {
      header: () => m.admin_proxies_servers_col_nodes(),
      cell: (info) => {
        const server = info.row.original;
        return (
          <Link
            to="/admin/proxies/nodes"
            search={{ serverId: server.id }}
            aria-label={m.admin_proxies_servers_action_view_nodes()}
            title={m.admin_proxies_servers_action_view_nodes()}
          >
            <Badge variant="outline">{info.getValue()}</Badge>
          </Link>
        );
      },
    }),
    columnHelper.display({
      id: "status",
      header: () => m.admin_proxies_servers_col_status(),
      cell: (info) => {
        const server = info.row.original;
        if (!server.enabled) {
          return (
            <Badge variant="outline">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-muted-foreground/64"
              />
              {m.admin_proxies_servers_status_disabled()}
            </Badge>
          );
        }
        const health = deriveServerHealth(server);
        const label = {
          agent_offline: m.admin_proxies_servers_status_offline(),
          runtime_error: m.admin_proxies_servers_status_runtime_error(),
          config_error: m.admin_proxies_servers_status_config_error(),
          degraded: m.admin_proxies_servers_status_degraded(),
          online: m.admin_proxies_servers_status_online(),
          unknown: m.admin_proxies_servers_status_unknown(),
          disabled: m.admin_proxies_servers_status_disabled(),
        }[health];
        const dotClass =
          health === "online"
            ? "bg-emerald-500"
            : health === "degraded" || health === "unknown"
              ? "bg-amber-500"
              : "bg-red-500";
        return (
          <div className="flex max-w-80 flex-col items-start gap-1">
            <Badge
              variant="outline"
              title={server.lastErrorMessage ?? undefined}
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${dotClass}`}
              />
              {label}
            </Badge>
            {server.lastErrorMessage &&
            ["degraded", "config_error", "runtime_error"].includes(health) ? (
              <span className="line-clamp-2 text-xs text-destructive">
                {server.lastErrorMessage}
              </span>
            ) : null}
            {server.agentUpdateState === "failed" ||
            server.singBoxUpdateState === "failed" ? (
              <span className="line-clamp-2 text-xs text-destructive">
                {server.agentUpdateError ??
                  server.singBoxUpdateError ??
                  m.admin_proxies_servers_update_failed()}
              </span>
            ) : null}
            {server.pendingConfigChanges > 0 ? (
              <span
                className="text-xs text-muted-foreground"
                title={m.admin_proxies_servers_pending_changes_help()}
              >
                {m.admin_proxies_servers_pending_changes({
                  count: server.pendingConfigChanges,
                })}
              </span>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const server = info.row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={
                      (deleteMutation.isPending &&
                        deleteMutation.variables === server.id) ||
                      (regenMutation.isPending &&
                        regenMutation.variables === server.id) ||
                      copyingServerId === server.id
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
                <MenuItem onClick={() => openEdit(server)}>
                  {m.admin_proxies_servers_action_edit()}
                </MenuItem>
                <MenuItem onClick={() => openNodes(server)}>
                  {m.admin_proxies_servers_action_view_nodes()}
                </MenuItem>
                <MenuItem onClick={() => addNode(server)}>
                  {m.admin_proxies_servers_action_add_node()}
                </MenuItem>
                <MenuItem onClick={() => void copyAgentInfo(server)}>
                  {m.admin_proxies_servers_action_copy_agent()}
                </MenuItem>
                <MenuItem onClick={() => regenMutation.mutate(server.id)}>
                  {m.admin_proxies_servers_action_reset_token()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestDelete(server)}
                >
                  {m.admin_proxies_servers_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: servers ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_proxies_item_servers()}</PageHeaderTitle>
        <Button render={<Link to="/admin/proxies/servers/new" />}>
          <PlusIcon />
          {m.admin_proxies_servers_add()}
        </Button>
      </PageHeader>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : servers && servers.length > 0 ? (
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
            <EmptyTitle>{m.admin_proxies_servers_empty_title()}</EmptyTitle>
          </EmptyHeader>
          <Button render={<Link to="/admin/proxies/servers/new" />}>
            <PlusIcon />
            {m.admin_proxies_servers_add()}
          </Button>
        </Empty>
      )}

      {servers && servers.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_status_note()}
        </p>
      ) : null}
    </div>
  );
}
