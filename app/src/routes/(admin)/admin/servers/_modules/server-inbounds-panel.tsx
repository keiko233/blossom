import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PencilIcon, PlusIcon } from "lucide-react";
import type React from "react";

import { PageContent, PageToolbar } from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { WorkspaceViewport } from "@/components/app-shell/workspace";
import {
  EntrancePublicationBadge,
  NodeHealthBadge,
} from "@/components/node-health-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
 * Server-scoped subscriber inbounds as a dense table. Nodes and certificates
 * load behind one gate; neither query blocks the other.
 */
export function ServerInboundsPanel({
  serverId,
}: ServerInboundsPanelProps): React.ReactElement {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
  });
  const { data: certificates, isPending: certificatesPending } = useQuery({
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
  const loading = isPending || certificatesPending;

  return (
    <WorkspaceViewport
      scrollId={`server-${serverId}-inbounds`}
      className="[--page-header-h:0px]"
    >
      <PageToolbar>
        <span className="text-xs text-muted-foreground">
          {m.admin_servers_inbounds_title()}
          {nodes
            ? ` · ${m.admin_servers_inbounds_count({ count: nodes.length })}`
            : ""}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
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
      </PageToolbar>

      {loading ? (
        <TableSkeleton rows={6} columns={7} />
      ) : isError || !nodes ? (
        <PageContent>
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {m.admin_proxies_servers_nodes_error()}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {m.admin_servers_inbounds_retry()}
            </Button>
          </div>
        </PageContent>
      ) : nodes.length === 0 ? (
        <PageContent>
          <p className="text-sm text-muted-foreground">
            {m.admin_proxies_servers_nodes_empty()}
          </p>
        </PageContent>
      ) : (
        <Table variant="pane">
          <TableHeader>
            <TableRow>
              <TableHead>{m.admin_server_ws_name()}</TableHead>
              <TableHead>{m.admin_server_ws_protocol()}</TableHead>
              <TableHead>{m.admin_server_ws_endpoint()}</TableHead>
              <TableHead>{m.admin_servers_inbounds_tls()}</TableHead>
              <TableHead>{m.admin_server_ws_health()}</TableHead>
              <TableHead>{m.admin_servers_inbounds_tags()}</TableHead>
              <TableHead className="w-px">
                <span className="sr-only">
                  {m.admin_servers_inbounds_edit()}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((node) => {
              const status = deriveEntranceStatus(node);
              return (
                <TableRow
                  key={node.id}
                  data-slot="server-inbound-row"
                  className="h-10"
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <Link
                        to="/admin/servers/$serverId/inbounds/$nodeId"
                        params={{ serverId, nodeId: node.id }}
                        className="max-w-56 truncate underline-offset-4 hover:underline"
                      >
                        {node.name}
                      </Link>
                      {node.remark ? (
                        <span className="max-w-56 truncate text-xs text-muted-foreground">
                          {node.remark}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{node.protocol}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {node.resolvedAddress}:{node.listenPort}
                  </TableCell>
                  <TableCell className="text-xs">
                    {tlsBindingLabel(node, certificateNames)}
                    {node.tlsServerName ? (
                      <span className="font-mono text-muted-foreground">
                        {" "}
                        · {node.tlsServerName}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <EntrancePublicationBadge
                        publication={status.publication}
                      />
                      <NodeHealthBadge health={status.health} />
                    </span>
                  </TableCell>
                  <TableCell>
                    {node.tags.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {node.tags.map((tag, index) => (
                          <Badge
                            key={`${tag}-${index}`}
                            size="sm"
                            variant="secondary"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {m.admin_servers_inbounds_no_tags()}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={m.admin_servers_inbounds_edit()}
                      render={
                        <Link
                          to="/admin/servers/$serverId/inbounds/$nodeId"
                          params={{ serverId, nodeId: node.id }}
                        />
                      }
                    >
                      <PencilIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 text-xs text-muted-foreground lg:px-6">
        <span>{m.admin_servers_inbounds_credentials_note()}</span>
        <Link
          className="underline underline-offset-4"
          to="/admin/networking/certificates"
        >
          {m.admin_servers_inbounds_manage_certificates()}
        </Link>
      </div>
    </WorkspaceViewport>
  );
}
