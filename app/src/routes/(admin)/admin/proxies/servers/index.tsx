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

// A server's agent is considered online if it heartbeated within this window.
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function isOnline(server: ServerListItem): boolean {
  if (!server.lastSeenAt) {
    return false;
  }
  return (
    Date.now() - new Date(server.lastSeenAt).getTime() < ONLINE_THRESHOLD_MS
  );
}

const columnHelper = createColumnHelper<ServerListItem>();

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: servers, isPending } = useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => listServers(),
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

    const confirmed = await Confirm.call({
      title: m.admin_proxies_servers_delete_title(),
      description: m.admin_proxies_servers_delete_description(),
      confirmLabel: m.admin_proxies_servers_action_delete(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      deleteMutation.mutate(server.id);
    }
  };

  const openCreate = () => void navigate({ to: "/admin/proxies/servers/new" });

  const openEdit = (server: ServerListItem) =>
    void navigate({
      to: "/admin/proxies/servers/$serverId",
      params: { serverId: server.id },
    });

  const copyAgentInfo = async (server: ServerListItem) => {
    const info = JSON.stringify(
      {
        serverId: server.id,
        address: server.address,
        tokenPrefix: server.agentTokenPrefix,
      },
      null,
      2,
    );
    await navigator.clipboard.writeText(info);
    toastManager.add({
      type: "success",
      title: m.admin_proxies_servers_toast_copied(),
    });
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
              {server.agentTokenPrefix}
              {server.agentVersion ? ` · v${server.agentVersion}` : ""}
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
    columnHelper.accessor("nodeCount", {
      header: () => m.admin_proxies_servers_col_nodes(),
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
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
        const online = isOnline(server);
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
              ? m.admin_proxies_servers_status_online()
              : m.admin_proxies_servers_status_offline()}
          </Badge>
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
                render={<Button size="icon" variant="ghost" />}
                aria-label="Actions"
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => openEdit(server)}>
                  {m.admin_proxies_servers_action_edit()}
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
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-semibold">
          {m.admin_nav_proxies_item_servers()}
        </h1>
        <Button onClick={openCreate}>
          <PlusIcon />
          {m.admin_proxies_servers_add()}
        </Button>
      </div>

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
          <Button onClick={openCreate}>
            <PlusIcon />
            {m.admin_proxies_servers_add()}
          </Button>
        </Empty>
      )}
    </div>
  );
}
