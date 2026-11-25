import { createFileRoute, Link } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
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
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (isError || !view) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-destructive">
          {m.admin_networking_load_error()}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {m.admin_networking_action_retry()}
        </Button>
      </div>
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
    <div className="flex flex-col gap-4">
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageHeaderTitle>{m.admin_servers_outbounds_title()}</PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_servers_outbounds_description()}
          </p>
        </div>
        <Menu>
          <MenuTrigger render={<Button size="sm" />}>
            <PlusIcon />
            {m.admin_servers_outbounds_add()}
          </MenuTrigger>
          <MenuPopup align="end">
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
      </PageHeader>

      {view.activationEnabled ? null : (
        <Alert variant="info">
          <AlertTitle>
            {m.admin_networking_activation_disabled_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_networking_activation_disabled_description()}
          </AlertDescription>
        </Alert>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {view.outbounds.map((outbound) => {
          const link = outbound.linkId
            ? view.links.find((row) => row.id === outbound.linkId)
            : null;
          return (
            <li
              key={outbound.id ?? "direct"}
              data-slot="server-outbound-row"
              className="flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {outbound.name}
                </span>
                <Badge variant="outline">
                  {outbound.kind === "builtin_direct"
                    ? m.admin_servers_outbounds_kind_direct()
                    : outbound.kind === "direct_profile"
                      ? m.admin_servers_outbounds_kind_profile()
                      : outbound.kind === "custom_proxy"
                        ? m.admin_servers_outbounds_kind_custom()
                        : outbound.kind === "outbound_group"
                          ? m.admin_servers_outbounds_kind_group()
                          : m.admin_servers_outbounds_kind_peer()}
                </Badge>
                {outbound.protocol ? (
                  <Badge variant="outline">{outbound.protocol}</Badge>
                ) : null}
                {link ? (
                  <>
                    <Badge
                      variant={link.phase === "applied" ? "success" : "outline"}
                    >
                      {link.phase}
                    </Badge>
                    <Badge variant="outline">{link.health}</Badge>
                  </>
                ) : null}
                {outbound.id ? (
                  <span className="flex gap-1">
                    {outbound.kind !== "peer_link" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_action_edit()}
                        onClick={() => {
                          setEditingId(outbound.id);
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
                      </Button>
                    ) : null}
                    {outbound.kind === "direct_profile" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_action_delete()}
                        onClick={() => void remove(outbound.id!)}
                      >
                        <Trash2Icon />
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{outbound.runtimeTag}</span>
                {outbound.kind === "direct_profile" ? (
                  <>
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
                  </>
                ) : null}
                {link ? (
                  <span>
                    {m.admin_servers_outbounds_link_to({
                      server: link.destinationServerName,
                      inbound: link.destinationInboundName,
                    })}
                  </span>
                ) : null}
                {outbound.kind === "outbound_group" ? (
                  <span>
                    {m.admin_servers_outbounds_group_member_count({
                      count: outbound.memberOutboundTags?.length ?? 0,
                    })}
                  </span>
                ) : null}
                <span>
                  {m.admin_servers_outbounds_route_refs({
                    count: outbound.routeRuleIds.length,
                  })}
                </span>
                <span>
                  {m.admin_servers_outbounds_revision({
                    revision: outbound.revision,
                  })}
                </span>
              </div>

              {outbound.kind === "outbound_group" &&
              (outbound.memberOutboundTags?.length ?? 0) > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {(outbound.memberOutboundTags ?? []).map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {outbound.routeRuleIds.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {outbound.routeRuleIds.map((ruleId) => (
                    <Badge key={ruleId} variant="outline">
                      {ruleId}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {link ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <Link
                      to="/admin/networking/links"
                      search={{ link: link.id }}
                    />
                  }
                >
                  {m.admin_networking_action_edit_link()}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
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
          variant="outline"
          render={<Link to="/admin/networking/topology" />}
        >
          {m.admin_networking_action_view_topology()}
        </Button>
      </div>

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
    </div>
  );
}
