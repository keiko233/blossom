import { Link } from "@tanstack/react-router";
import type React from "react";

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

function detailRow(label: string, value: React.ReactNode): React.ReactElement {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
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
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate font-medium">{server.name}</h2>
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
        {detailRow(m.admin_networking_topology_address(), server.address)}
        {detailRow(
          m.admin_networking_topology_agent_state(),
          `${server.runtimeState} / ${server.configState}`,
        )}
        {detailRow(
          m.admin_networking_topology_sequence(),
          `${server.appliedRevisionSeq} / ${server.desiredRevisionSeq}`,
        )}
        {detailRow(
          m.admin_networking_topology_links_count(),
          m.admin_networking_topology_summary({
            outgoing: summary.outgoing.length,
            incoming: summary.incoming.length,
          }),
        )}
        {detailRow(
          m.admin_networking_topology_route_draft(),
          draft
            ? m.admin_networking_topology_route_draft_version({
                version: draft.version,
                rules: draft.rules.length,
              })
            : m.admin_networking_topology_route_draft_none(),
        )}
        <div className="flex flex-wrap gap-2 pt-1">
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 font-medium">
          {m.admin_networking_topology_link_details()}
        </h2>
        <LinkPhaseBadge phase={link.phase} />
        <LinkHealthBadge health={link.health} />
      </div>
      {detailRow(
        m.admin_networking_topology_source(),
        `${link.sourceServerName} · ${link.sourceServerId}`,
      )}
      {detailRow(
        m.admin_networking_topology_destination(),
        `${link.destinationServerName} · ${link.destinationInboundName}`,
      )}
      {detailRow(m.admin_networking_topology_protocol(), link.protocol)}
      {detailRow(
        m.admin_networking_topology_outbound(),
        `${link.outboundName} · ${link.outboundTag}`,
      )}
      {detailRow(
        m.admin_networking_topology_credential_generation(),
        m.admin_networking_topology_credential_value({
          generation: link.credentialGeneration ?? 0,
          revisions: link.credentialRevision,
        }),
      )}
      {detailRow(m.admin_networking_topology_revision(), String(link.revision))}
      {detailRow(
        m.admin_networking_topology_probe(),
        link.probeAt
          ? m.admin_networking_topology_probe_value({
              outcome: link.probeOutcome ?? "unknown",
              time: formatDateTime(link.probeAt),
            })
          : m.admin_networking_topology_probe_none(),
      )}
      {detailRow(
        m.admin_networking_topology_route_refs_count(),
        String(link.routeRuleIds.length),
      )}
      {referencingRules.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {referencingRules.map((rule) => (
            <li
              key={rule.ruleId}
              className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
            >
              {rule.ruleId} · {rule.inboundTags.join(", ")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {m.admin_networking_topology_no_route_refs()}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        render={<Link to="/admin/networking/links" />}
      >
        {m.admin_networking_action_edit_link()}
      </Button>
    </div>
  );
}
