import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  Link2Icon,
  PlusIcon,
  RotateCwIcon,
  SettingsIcon,
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

import { LinkEditorDialog } from "./_modules/link-editor-dialog";
import {
  LinkHealthBadge,
  LinkPhaseBadge,
  NetworkingSection,
} from "./_modules/networking-badges";
import { NetworkingRollouts } from "./_modules/networking-rollouts";
import { networkingWriteReasonMessage } from "./_modules/networking-write-message";
import {
  useInvalidateNetworking,
  useNetworkingWorkspace,
} from "./_modules/use-networking-workspace";

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
  const [actionError, setActionError] = useState<string | null>(null);
  const [consumedLink, setConsumedLink] = useState<string | null>(null);

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
    </div>
  );
}
