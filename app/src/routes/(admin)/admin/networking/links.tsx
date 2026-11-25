import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  Link2Icon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { z } from "zod";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useLockFn } from "@/hooks/use-lock-fn";
import { m } from "@/paraglide/messages";
import { deletePeerLink, rotatePeerLinkCredential } from "@/query/networking";
import {
  PORT_FORWARDS_QUERY_KEY,
  deletePortForward,
  listPortForwards,
} from "@/query/port-forwards";

import { AutoBridgeDialog } from "./_modules/auto-bridge-dialog";
import { LinkEditorDialog } from "./_modules/link-editor-dialog";
import {
  LinkHealthBadge,
  LinkPhaseBadge,
  NetworkingSection,
} from "./_modules/networking-badges";
import { NetworkingRollouts } from "./_modules/networking-rollouts";
import { networkingWriteReasonMessage } from "./_modules/networking-write-message";
import {
  PortForwardDialog,
  type PortForwardRow,
} from "./_modules/port-forward-dialog";
import {
  useInvalidateNetworking,
  useNetworkingWorkspace,
} from "./_modules/use-networking-workspace";

const NETWORK_LABEL: Record<"tcp" | "udp" | "both", () => string> = {
  both: m.admin_networking_network_both,
  tcp: m.admin_networking_network_tcp,
  udp: m.admin_networking_network_udp,
};

export const Route = createFileRoute("/(admin)/admin/networking/links")({
  staticData: {
    crumb: () => m.admin_workspace_networking_links(),
  },
  validateSearch: z.object({
    source: z.string().optional(),
    link: z.string().optional(),
  }),
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const { data, isPending, isError, refetch } = useNetworkingWorkspace();
  const invalidate = useInvalidateNetworking();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoBridgeOpen, setAutoBridgeOpen] = useState(false);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [editingForwardId, setEditingForwardId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [consumedLink, setConsumedLink] = useState<string | null>(null);
  const { data: portForwards, refetch: refetchPortForwards } = useQuery({
    queryKey: PORT_FORWARDS_QUERY_KEY,
    queryFn: () => listPortForwards(),
  });

  useEffect(() => {
    if (!data || !search.link || search.link === consumedLink) return;
    const target = data.links.find((row) => row.id === search.link);
    if (!target) return;
    setConsumedLink(search.link);
    setEditingId(target.id);
    setEditorOpen(true);
  }, [data, search.link, consumedLink]);

  const run = async (
    operation: () => Promise<{
      ok: boolean;
      reason?: string;
      message?: string;
    }>,
  ) => {
    if (!data) return false;
    setActionError(null);
    const result = await operation();
    if (!result.ok) {
      setActionError(networkingWriteReasonMessage(result.reason ?? "unknown"));
      return false;
    }
    await invalidate();
    return true;
  };

  const rotate = useLockFn(async (id: string) => {
    if (!data) return;
    if (
      !(await run(() =>
        rotatePeerLinkCredential({
          data: { id, expectedTopologyGeneration: data.topologyGeneration },
        }),
      ))
    )
      return;
    toastManager.add({
      type: "success",
      title: m.admin_networking_links_toast_rotated(),
    });
  });

  const remove = useLockFn(async (id: string) => {
    if (!data) return;
    await Confirm.call({
      title: m.admin_networking_links_delete_title(),
      description: m.admin_networking_links_delete_description(),
      confirmLabel: m.admin_networking_action_delete(),
      cancelLabel: m.admin_networking_action_cancel(),
      destructive: true,
      onConfirm: async () => {
        if (!data) return;
        if (
          !(await run(() =>
            deletePeerLink({
              data: { id, expectedTopologyGeneration: data.topologyGeneration },
            }),
          ))
        )
          return;
        toastManager.add({
          type: "success",
          title: m.admin_networking_links_toast_deleted(),
        });
      },
    });
  });

  const removePortForward = useLockFn(async (id: string) => {
    if (!data) return;
    await Confirm.call({
      title: m.admin_networking_port_forward_delete_title(),
      description: m.admin_networking_port_forward_delete_description(),
      confirmLabel: m.admin_networking_action_delete(),
      cancelLabel: m.admin_networking_action_cancel(),
      destructive: true,
      onConfirm: async () => {
        if (!data) return;
        setActionError(null);
        const result = await deletePortForward({
          data: {
            id,
            expectedTopologyGeneration: data.topologyGeneration,
          },
        });
        if (!result.ok) {
          setActionError(networkingWriteReasonMessage(result.reason));
          return;
        }
        toastManager.add({
          type: "success",
          title: m.admin_networking_port_forward_toast_deleted(),
        });
        await invalidate();
        await refetchPortForwards();
      },
    });
  });

  if (isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex flex-col gap-3 p-4 md:p-6">
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
      : (data.links.find((row) => row.id === editingId) ?? null);
  const editingForward: PortForwardRow | null =
    editingForwardId === null
      ? null
      : ((portForwards ?? []).find((row) => row.id === editingForwardId) ??
        null);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageHeaderTitle>
            {m.admin_workspace_networking_links()}
          </PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_networking_links_description()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoBridgeOpen(true)}
          >
            <SparklesIcon />
            {m.admin_networking_auto_bridge_action()}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditingId(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon />
            {m.admin_networking_action_add_link()}
          </Button>
        </div>
      </PageHeader>

      {data.activationEnabled ? null : (
        <Alert variant="info">
          <AlertTitle>
            {m.admin_networking_activation_disabled_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_networking_activation_disabled_description()}
          </AlertDescription>
        </Alert>
      )}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <NetworkingSection
        title={m.admin_networking_links_list_title()}
        description={m.admin_networking_links_list_description()}
      >
        {data.links.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{m.admin_networking_links_empty_title()}</EmptyTitle>
            </EmptyHeader>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingId(null);
                setEditorOpen(true);
              }}
            >
              {m.admin_networking_action_add_link()}
            </Button>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.links.map((link) => (
              <li
                key={link.id}
                data-slot="networking-link-row"
                className="flex flex-col gap-2 rounded-lg border bg-background p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Link2Icon aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 truncate text-sm font-medium">
                      {link.sourceServerName}
                    </span>
                    <ArrowRightIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 truncate text-sm font-medium">
                      {link.destinationServerName}
                    </span>
                  </span>
                  <Badge variant="outline">{link.protocol}</Badge>
                  <LinkPhaseBadge phase={link.phase} />
                  <LinkHealthBadge health={link.health} />
                  <span className="ms-auto flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={m.admin_networking_action_edit()}
                      onClick={() => {
                        setEditingId(link.id);
                        setEditorOpen(true);
                      }}
                    >
                      <SettingsIcon />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={m.admin_networking_action_rotate()}
                      onClick={() => void rotate(link.id)}
                    >
                      <RotateCwIcon />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={m.admin_networking_action_delete()}
                      onClick={() => void remove(link.id)}
                    >
                      <Trash2Icon />
                    </Button>
                  </span>
                </div>

                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <span>
                    {m.admin_networking_links_inbound({
                      inbound: link.destinationInboundName,
                    })}
                  </span>
                  <span>
                    {m.admin_networking_links_outbound({
                      outbound: link.outboundName,
                      tag: link.outboundTag,
                    })}
                  </span>
                  <span>
                    {m.admin_networking_links_credential({
                      generation: link.credentialGeneration ?? 0,
                      revisions: link.credentialRevision,
                    })}
                  </span>
                  <span>
                    {m.admin_networking_links_routes({
                      count: link.routeRuleIds.length,
                    })}
                  </span>
                  {link.probeAt ? (
                    <span>
                      {m.admin_networking_links_probe({
                        outcome: link.probeOutcome ?? "unknown",
                      })}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </NetworkingSection>

      <NetworkingSection
        title={m.admin_networking_port_forward_title()}
        description={m.admin_networking_port_forward_description()}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingForwardId(null);
              setPortForwardOpen(true);
            }}
          >
            <PlusIcon />
            {m.admin_networking_port_forward_add()}
          </Button>
        }
      >
        {(portForwards ?? []).length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{m.admin_networking_port_forward_empty()}</EmptyTitle>
            </EmptyHeader>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingForwardId(null);
                setPortForwardOpen(true);
              }}
            >
              {m.admin_networking_port_forward_add()}
            </Button>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {(portForwards ?? []).map((forward) => {
              const transit = data.servers.find(
                (row) => row.id === forward.serverId,
              );
              const targetNode = forward.targetNodeId
                ? data.nodes.find((row) => row.id === forward.targetNodeId)
                : null;
              return (
                <li
                  key={forward.id}
                  data-slot="networking-port-forward-row"
                  className="flex flex-col gap-2 rounded-lg border bg-background p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <NetworkIcon aria-hidden className="size-4 shrink-0" />
                      <span className="min-w-0 truncate text-sm font-medium">
                        {forward.name}
                      </span>
                    </span>
                    <Badge variant="outline">
                      {NETWORK_LABEL[forward.network]()}
                    </Badge>
                    <Badge variant={forward.enabled ? "success" : "outline"}>
                      {forward.enabled
                        ? m.admin_networking_port_forward_enabled_label()
                        : m.admin_networking_port_forward_disabled_label()}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {forward.runtimeTag}
                    </span>
                    <span className="ms-auto flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_action_edit()}
                        onClick={() => {
                          setEditingForwardId(forward.id);
                          setPortForwardOpen(true);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_action_delete()}
                        onClick={() => void removePortForward(forward.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    </span>
                  </div>
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <span>
                      {m.admin_networking_port_forward_transit({
                        server: transit?.name ?? forward.serverId,
                      })}
                    </span>
                    <span>
                      {m.admin_networking_port_forward_listen({
                        address: forward.listenAddress,
                        port: forward.listenPort,
                      })}
                    </span>
                    <span>
                      {targetNode
                        ? m.admin_networking_port_forward_node_target({
                            node: targetNode.name,
                          })
                        : m.admin_networking_port_forward_external_target({
                            address: forward.targetAddress ?? "",
                            port: forward.targetPort ?? 0,
                          })}
                    </span>
                    {forward.outboundTag ? (
                      <span>
                        {m.admin_networking_port_forward_outbound({
                          tag: forward.outboundTag,
                        })}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </NetworkingSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <NetworkingSection
          title={m.admin_networking_links_editor_title()}
          description={m.admin_networking_links_editor_description()}
        >
          <p className="text-sm text-muted-foreground">
            {m.admin_networking_links_editor_hint()}
          </p>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/networking/topology" />}
          >
            {m.admin_networking_action_view_topology()}
          </Button>
        </NetworkingSection>
        <NetworkingRollouts
          rollouts={data.rollouts}
          activationEnabled={data.activationEnabled}
        />
      </div>

      <LinkEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditingId(null);
        }}
        workspace={data}
        link={editing}
        defaultSourceServerId={search.source}
      />

      <AutoBridgeDialog
        open={autoBridgeOpen}
        onOpenChange={setAutoBridgeOpen}
        workspace={data}
        defaultSourceServerId={search.source}
      />

      <PortForwardDialog
        open={portForwardOpen}
        onOpenChange={(open) => {
          setPortForwardOpen(open);
          if (!open) setEditingForwardId(null);
        }}
        workspace={data}
        forward={editingForward}
      />
    </div>
  );
}
