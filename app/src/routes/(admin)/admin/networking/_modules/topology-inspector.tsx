import { Link } from "@tanstack/react-router";
import type React from "react";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type {
  TopologyList,
  TopologySelection,
} from "@/lib/networking-topology";
import { m } from "@/paraglide/messages";
import type { NetworkingWorkspaceData } from "@/query/networking-read";

import { LinkHealthBadge, LinkPhaseBadge } from "./networking-badges";

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 text-sm">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function DetailList({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <dl className="flex flex-col gap-2">{children}</dl>;
}

export function TopologyInspector({
  selection,
  list,
  workspace,
}: {
  selection: TopologySelection | null;
  list: TopologyList;
  workspace: NetworkingWorkspaceData;
}): React.ReactElement {
  if (!selection) {
    return (
      <p className="text-sm text-muted-foreground">
        {m.admin_networking_topology_select_prompt()}
      </p>
    );
  }

  if (selection.kind === "server") {
    const server = workspace.servers.find((row) => row.id === selection.id);
    const summary = list.servers.find((row) => row.id === selection.id);
    if (!server || !summary) {
      return (
        <p className="text-sm text-muted-foreground">
          {m.admin_networking_topology_no_match()}
        </p>
      );
    }
    const draft = workspace.routingDrafts.find(
      (row) => row.serverId === server.id,
    );
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader>
          <div className="flex min-w-0 items-center gap-2">
            <SectionTitle>{server.name}</SectionTitle>
            {server.enabled ? (
              <Badge variant="success">
                {m.admin_networking_topology_enabled()}
              </Badge>
            ) : (
              <Badge variant="warning">
                {m.admin_networking_topology_server_disabled()}
              </Badge>
            )}
          </div>
        </SectionHeader>

        <DetailList>
          <DetailRow label={m.admin_networking_topology_address()}>
            <span className="font-mono text-xs">{server.address}</span>
          </DetailRow>
          <DetailRow label={m.admin_networking_topology_agent_state()}>
            <span className="font-mono text-xs">
              {server.runtimeState} / {server.configState}
            </span>
          </DetailRow>
          <DetailRow label={m.admin_networking_topology_sequence()}>
            <span className="tabular-nums">
              {server.appliedRevisionSeq} / {server.desiredRevisionSeq}
            </span>
          </DetailRow>
          <DetailRow label={m.admin_networking_topology_links_count()}>
            <span className="tabular-nums">
              {m.admin_networking_topology_summary({
                outgoing: summary.outgoing.length,
                incoming: summary.incoming.length,
              })}
            </span>
          </DetailRow>
          <DetailRow label={m.admin_networking_topology_route_draft()}>
            {draft
              ? m.admin_networking_topology_route_draft_version({
                  version: draft.version,
                  rules: draft.rules.length,
                })
              : m.admin_networking_topology_route_draft_none()}
          </DetailRow>
        </DetailList>

        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/admin/servers/$serverId/outbounds"
                params={{ serverId: server.id }}
              />
            }
          >
            {m.admin_networking_action_view_outbounds()}
          </Button>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/networking/routing" />}
          >
            {m.admin_networking_action_view_routing()}
          </Button>
        </div>
      </div>
    );
  }

  const link = workspace.links.find((row) => row.id === selection.id);
  if (!link) {
    return (
      <p className="text-sm text-muted-foreground">
        {m.admin_networking_topology_no_match()}
      </p>
    );
  }
  const draft = workspace.routingDrafts.find(
    (row) => row.serverId === link.sourceServerId,
  );
  const referencingRules =
    draft?.rules.filter(
      (rule) =>
        rule.action === "route" && rule.outboundTag === link.outboundTag,
    ) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader>
        <div className="flex min-w-0 items-center gap-2">
          <SectionTitle>
            {m.admin_networking_topology_link_details()}
          </SectionTitle>
          <LinkPhaseBadge phase={link.phase} />
          <LinkHealthBadge health={link.health} />
        </div>
      </SectionHeader>

      <DetailList>
        <DetailRow label={m.admin_networking_topology_source()}>
          <span className="font-mono text-xs">{link.sourceServerName}</span>
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_destination()}>
          <span className="font-mono text-xs">
            {link.destinationServerName} · {link.destinationInboundName}
          </span>
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_protocol()}>
          <span className="font-mono text-xs">{link.protocol}</span>
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_outbound()}>
          <span className="font-mono text-xs">
            {link.outboundName} · {link.outboundTag}
          </span>
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_credential_generation()}>
          <span className="tabular-nums">
            {m.admin_networking_topology_credential_value({
              generation: link.credentialGeneration ?? 0,
              revisions: link.credentialRevision,
            })}
          </span>
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_revision()}>
          <span className="tabular-nums">{link.revision}</span>
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_probe()}>
          {link.probeAt
            ? m.admin_networking_topology_probe_value({
                outcome: link.probeOutcome ?? "unknown",
                time: formatDateTime(link.probeAt),
              })
            : m.admin_networking_topology_probe_none()}
        </DetailRow>
        <DetailRow label={m.admin_networking_topology_route_refs_count()}>
          <span className="tabular-nums">{link.routeRuleIds.length}</span>
        </DetailRow>
      </DetailList>

      {referencingRules.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t pt-3">
          {referencingRules.map((rule) => (
            <li
              key={rule.ruleId}
              className="font-mono text-xs text-muted-foreground"
            >
              {rule.ruleId} · {rule.inboundTags.join(", ")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          {m.admin_networking_topology_no_route_refs()}
        </p>
      )}

      <div className="border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          render={
            <Link to="/admin/networking/links" search={{ link: link.id }} />
          }
        >
          {m.admin_networking_action_edit_link()}
        </Button>
      </div>
    </div>
  );
}
