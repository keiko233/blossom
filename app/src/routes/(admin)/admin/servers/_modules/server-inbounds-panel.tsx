import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PencilIcon, PlusIcon } from "lucide-react";
import type React from "react";

import {
  EntrancePublicationBadge,
  NodeHealthBadge,
} from "@/components/node-health-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deriveEntranceStatus } from "@/lib/group-entrance-filter";
import { filterNodesByServer } from "@/lib/server-node-context";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  protocolSupportsTls,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";
import { CERTIFICATES_QUERY_KEY, listCertificates } from "@/query/certificates";
import { listNodes, NODES_QUERY_KEY, type NodeListItem } from "@/query/nodes";

export interface ServerInboundsPanelProps {
  serverId: string;
}

function tlsBindingLabel(
  node: NodeListItem,
  certificateNames: ReadonlyMap<string, string>,
): string {
  if (!protocolSupportsTls(node.protocol)) {
    return m.admin_servers_inbounds_tls_none();
  }
  if (isNodeRealityEnabled(node.settings)) {
    return m.admin_servers_inbounds_tls_reality();
  }
  if (!isNodeTlsEnabled(node.settings)) {
    return m.admin_servers_inbounds_tls_disabled();
  }
  if (node.certificateId) {
    const name = certificateNames.get(node.certificateId);
    return name
      ? m.admin_servers_inbounds_tls_managed({ name })
      : m.admin_servers_inbounds_tls_managed_unknown();
  }
  return m.admin_servers_inbounds_tls_legacy();
}

/**
 * Server-scoped subscriber inbounds. It reads the existing node rows without
 * changing their settings, TLS binding, tags or generated credentials, and
 * deliberately omits managed peer/outbound details that do not have a data
 * contract yet.
 */
export function ServerInboundsPanel({
  serverId,
}: ServerInboundsPanelProps): React.ReactElement {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
  });
  const { data: certificates } = useQuery({
    queryKey: CERTIFICATES_QUERY_KEY,
    queryFn: () => listCertificates(),
  });

  const nodes = data ? filterNodesByServer(data, serverId) : undefined;
  const certificateNames = new Map(
    (certificates ?? []).map((certificate) => [
      certificate.id,
      certificate.name,
    ]),
  );

  return (
    <section
      data-slot="server-inbounds-panel"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{m.admin_servers_inbounds_title()}</h2>
            {nodes ? (
              <Badge variant="outline">
                {m.admin_servers_inbounds_count({ count: nodes.length })}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {m.admin_servers_inbounds_description()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/networking/topology" />}
          >
            {m.admin_servers_inbounds_view_topology()}
          </Button>
          <Button
            size="sm"
            render={
              <Link
                to="/admin/servers/$serverId/inbounds/new"
                params={{ serverId }}
              />
            }
          >
            <PlusIcon />
            {m.admin_proxies_servers_action_add_node()}
          </Button>
        </div>
      </div>

      {isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">
            {m.admin_proxies_servers_nodes_error()}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {m.admin_servers_inbounds_retry()}
          </Button>
        </div>
      ) : nodes && nodes.length > 0 ? (
        <ul
          aria-label={m.admin_servers_inbounds_title()}
          className="flex flex-col divide-y rounded-lg border bg-background"
        >
          {nodes.map((node) => {
            const status = deriveEntranceStatus(node);
            return (
              <li
                key={node.id}
                data-slot="server-inbound-row"
                className="flex flex-col gap-2 p-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                      to="/admin/servers/$serverId/inbounds/$nodeId"
                      params={{ serverId, nodeId: node.id }}
                      className="min-w-0 truncate text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {node.name}
                    </Link>
                    {node.remark ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {node.remark}
                      </span>
                    ) : null}
                  </div>
                  <Badge variant="outline">{node.protocol}</Badge>
                  <EntrancePublicationBadge publication={status.publication} />
                  <NodeHealthBadge health={status.health} />
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={m.admin_servers_inbounds_edit()}
                    render={
                      <Link
                        to="/admin/servers/$serverId/inbounds/$nodeId"
                        params={{ serverId, nodeId: node.id }}
                      />
                    }
                  >
                    <PencilIcon />
                    <span className="max-sm:sr-only">
                      {m.admin_servers_inbounds_edit()}
                    </span>
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    <span className="font-medium text-foreground">
                      {m.admin_servers_inbounds_endpoint()}:
                    </span>{" "}
                    <span className="font-mono">
                      {node.resolvedAddress}:{node.listenPort}
                    </span>
                  </span>
                  <span>
                    <span className="font-medium text-foreground">
                      {m.admin_servers_inbounds_tls()}:
                    </span>{" "}
                    {tlsBindingLabel(node, certificateNames)}
                    {node.tlsServerName ? (
                      <span className="font-mono"> · {node.tlsServerName}</span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="font-medium text-foreground">
                      {m.admin_servers_inbounds_tags()}:
                    </span>{" "}
                    {node.tags.length > 0
                      ? node.tags.map((tag, index) => (
                          <Badge
                            key={`${tag}-${index}`}
                            size="sm"
                            variant="secondary"
                          >
                            {tag}
                          </Badge>
                        ))
                      : m.admin_servers_inbounds_no_tags()}
                  </span>
                  {!node.enabled ? (
                    <span className="text-destructive">
                      {m.admin_proxies_nodes_status_disabled()}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {m.admin_proxies_servers_nodes_empty()}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{m.admin_servers_inbounds_credentials_note()}</span>
        <Link
          className="underline underline-offset-4"
          to="/admin/networking/certificates"
        >
          {m.admin_servers_inbounds_manage_certificates()}
        </Link>
      </div>
    </section>
  );
}
