import { createFileRoute, Link } from "@tanstack/react-router";
import { EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { PageContent, PageToolbar } from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { WorkspaceViewport } from "@/components/app-shell/workspace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { StatusDot } from "@/components/ui/status-dot";
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
import { deleteManagedOutbound } from "@/query/networking";

import { useServerRouting } from "../../networking/_modules/use-networking-workspace";
import {
  OutboundEditorDialog,
  type OutboundEditorKind,
} from "../_modules/outbound-editor-dialog";
import { useWorkspaceServer } from "../_modules/use-workspace-server";

export const Route = createFileRoute(
  "/(admin)/admin/servers/$serverId/outbounds",
)({
  staticData: {
    crumb: () => m.admin_proxies_servers_workspace_tab_outbounds(),
  },
  component: RouteComponent,
});

const phaseLabel = {
  draft: m.admin_networking_link_phase_draft,
  pending: m.admin_networking_link_phase_pending,
  applying: m.admin_networking_link_phase_applying,
  stalled: m.admin_networking_link_phase_stalled,
  failed: m.admin_networking_link_phase_failed,
  applied: m.admin_networking_link_phase_applied,
  removing: m.admin_networking_link_phase_removing,
};

const healthLabel = {
  unknown: m.admin_networking_link_health_unknown,
  healthy: m.admin_networking_link_health_healthy,
  degraded: m.admin_networking_link_health_degraded,
};

function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  const {
    data: view,
    isPending,
    isError,
    refetch,
  } = useServerRouting(server.id);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorKind, setEditorKind] =
    useState<OutboundEditorKind>("direct_profile");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (isPending) {
    return (
      <WorkspaceViewport
        scrollId={`server-${server.id}-outbounds`}
        className="[--page-header-h:0px]"
      >
        <PageToolbar>
          <span className="text-xs text-muted-foreground">
            {m.admin_servers_outbounds_title()}
          </span>
        </PageToolbar>
        <TableSkeleton rows={6} columns={6} />
      </WorkspaceViewport>
    );
  }
  if (isError || !view) {
    return (
      <WorkspaceViewport
        scrollId={`server-${server.id}-outbounds`}
        className="[--page-header-h:0px]"
      >
        <PageContent>
          <p role="alert" className="text-sm text-destructive">
            {m.admin_networking_load_error()}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {m.admin_networking_action_retry()}
          </Button>
        </PageContent>
      </WorkspaceViewport>
    );
  }

  const editing =
    editingId === null
      ? null
      : (view.outbounds.find((row) => row.id === editingId) ?? null);

  const remove = async (id: string) => {
    await Confirm.call({
      title: m.admin_servers_outbounds_delete_title(),
      description: m.admin_servers_outbounds_delete_description(),
      confirmLabel: m.admin_networking_action_delete(),
      cancelLabel: m.admin_networking_action_cancel(),
      destructive: true,
      onConfirm: async () => {
        setError(null);
        const result = await deleteManagedOutbound({
          data: {
            id,
            expectedTopologyGeneration: view.topologyGeneration,
          },
        });
        if (!result.ok) {
          setError(
            result.reason === "referenced"
              ? m.admin_networking_issue_referenced_resource()
              : (result.message ?? m.admin_networking_write_failed()),
          );
          return;
        }
        toastManager.add({
          type: "success",
          title: m.admin_servers_outbounds_toast_deleted(),
        });
        await refetch();
      },
    });
  };

  return (
    <WorkspaceViewport
      scrollId={`server-${server.id}-outbounds`}
      className="[--page-header-h:0px]"
    >
      <PageToolbar>
        <Menu>
          <MenuTrigger render={<Button size="sm" />}>
            <PlusIcon />
            {m.admin_servers_outbounds_add()}
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem
              onClick={() => {
                setEditingId(null);
                setEditorKind("direct_profile");
                setEditorOpen(true);
              }}
            >
              {m.admin_servers_outbounds_add_direct()}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setEditingId(null);
                setEditorKind("custom_proxy");
                setEditorOpen(true);
              }}
            >
              {m.admin_servers_outbounds_add_custom()}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setEditingId(null);
                setEditorKind("outbound_group");
                setEditorOpen(true);
              }}
            >
              {m.admin_servers_outbounds_add_group()}
            </MenuItem>
            <MenuItem
              render={
                <Link
                  to="/admin/networking/links"
                  search={{ source: server.id }}
                />
              }
            >
              {m.admin_servers_outbounds_add_peer()}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/admin/networking/routing"
              search={{ server: server.id }}
            />
          }
        >
          {m.admin_servers_outbounds_open_routing()}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          render={<Link to="/admin/networking/topology" />}
        >
          {m.admin_networking_action_view_topology()}
        </Button>
      </PageToolbar>

      <PageContent width="flush">
        {view.activationEnabled ? null : (
          <Alert variant="info" className="mx-4 mt-4 lg:mx-6">
            <AlertTitle>
              {m.admin_networking_activation_disabled_title()}
            </AlertTitle>
            <AlertDescription>
              {m.admin_networking_activation_disabled_description()}
            </AlertDescription>
          </Alert>
        )}

        {error ? (
          <p
            role="alert"
            className="px-4 pt-4 text-sm text-destructive lg:px-6"
          >
            {error}
          </p>
        ) : null}

        {view.outbounds.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground lg:p-6">
            {m.admin_servers_outbounds_empty_title()}
          </p>
        ) : (
          <Table variant="pane">
            <TableHeader>
              <TableRow>
                <TableHead>{m.admin_server_ws_name()}</TableHead>
                <TableHead>{m.admin_server_ws_kind()}</TableHead>
                <TableHead>{m.admin_server_ws_tag()}</TableHead>
                <TableHead>{m.admin_server_ws_destination()}</TableHead>
                <TableHead>{m.admin_server_ws_phase_health()}</TableHead>
                <TableHead>{m.admin_server_ws_routes()}</TableHead>
                <TableHead>{m.admin_server_ws_revision()}</TableHead>
                <TableHead className="w-px">
                  <span className="sr-only">{m.admin_server_ws_actions()}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.outbounds.map((outbound) => {
                const link = outbound.linkId
                  ? (view.links.find((row) => row.id === outbound.linkId) ??
                    null)
                  : null;
                const statusTone =
                  link?.phase === "applied"
                    ? link.health === "healthy"
                      ? "success"
                      : link.health === "degraded"
                        ? "warning"
                        : "muted"
                    : link?.phase === "failed"
                      ? "danger"
                      : link
                        ? "info"
                        : "muted";
                return (
                  <TableRow
                    key={outbound.id ?? "direct"}
                    data-slot="server-outbound-row"
                  >
                    <TableCell className="font-medium">
                      {outbound.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span>
                          {outbound.kind === "builtin_direct"
                            ? m.admin_servers_outbounds_kind_direct()
                            : outbound.kind === "direct_profile"
                              ? m.admin_servers_outbounds_kind_profile()
                              : outbound.kind === "custom_proxy"
                                ? m.admin_servers_outbounds_kind_custom()
                                : outbound.kind === "outbound_group"
                                  ? m.admin_servers_outbounds_kind_group()
                                  : m.admin_servers_outbounds_kind_peer()}
                        </span>
                        {outbound.protocol ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            · {outbound.protocol}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {outbound.runtimeTag}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {link ? (
                        m.admin_servers_outbounds_link_to({
                          server: link.destinationServerName,
                          inbound: link.destinationInboundName,
                        })
                      ) : outbound.kind === "direct_profile" ? (
                        <span className="flex gap-2">
                          {outbound.bindInterface ? (
                            <span>
                              {m.admin_servers_outbounds_interface({
                                name: outbound.bindInterface,
                              })}
                            </span>
                          ) : null}
                          <span>
                            {m.admin_servers_outbounds_ip({
                              family: outbound.ipFamily ?? "any",
                            })}
                          </span>
                        </span>
                      ) : outbound.kind === "outbound_group" ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span>
                            {m.admin_servers_outbounds_group_member_count({
                              count: outbound.memberOutboundTags?.length ?? 0,
                            })}
                          </span>
                          {(outbound.memberOutboundTags ?? []).length > 0 ? (
                            <span className="font-mono text-xs">
                              ({(outbound.memberOutboundTags ?? []).join(", ")})
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {link ? (
                        <span className="flex items-center gap-1.5">
                          <StatusDot
                            label={healthLabel[link.health]()}
                            tone={statusTone}
                          />
                          <span className="text-xs">
                            {phaseLabel[link.phase]()} ·{" "}
                            {healthLabel[link.health]()}
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {m.admin_server_ws_direct_egress()}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {outbound.routeRuleIds.length}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {outbound.revision}
                    </TableCell>
                    <TableCell>
                      {outbound.id ? (
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={m.admin_server_ws_actions()}
                              />
                            }
                          >
                            <EllipsisIcon />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            {outbound.kind !== "peer_link" ? (
                              <MenuItem
                                onClick={() => {
                                  setEditingId(outbound.id!);
                                  setEditorKind(
                                    outbound.kind === "custom_proxy"
                                      ? "custom_proxy"
                                      : outbound.kind === "outbound_group"
                                        ? "outbound_group"
                                        : "direct_profile",
                                  );
                                  setEditorOpen(true);
                                }}
                              >
                                <PencilIcon />
                                {m.admin_networking_action_edit()}
                              </MenuItem>
                            ) : null}
                            {link ? (
                              <MenuItem
                                render={
                                  <Link
                                    to="/admin/networking/links"
                                    search={{ link: link.id }}
                                  />
                                }
                              >
                                {m.admin_networking_action_edit_link()}
                              </MenuItem>
                            ) : null}
                            {outbound.kind === "direct_profile" ? (
                              <MenuItem
                                variant="destructive"
                                onClick={() => void remove(outbound.id!)}
                              >
                                <Trash2Icon />
                                {m.admin_networking_action_delete()}
                              </MenuItem>
                            ) : null}
                          </MenuPopup>
                        </Menu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </PageContent>

      <OutboundEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditingId(null);
        }}
        view={view}
        outbound={editing}
        initialKind={editorKind}
      />
    </WorkspaceViewport>
  );
}
