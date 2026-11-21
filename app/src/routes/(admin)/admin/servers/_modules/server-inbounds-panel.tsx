import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { filterNodesByServer } from "@/lib/server-node-context";
import { m } from "@/paraglide/messages";
import { listNodes, NODES_QUERY_KEY } from "@/query/nodes";

export interface ServerInboundsPanelProps {
  serverId: string;
}

/**
 * The subscriber inbounds currently backed by this server's nodes. This keeps
 * the existing node editor reachable until the Inbounds workspace replaces it;
 * managed peer details and dependencies arrive with that layer.
 */
export function ServerInboundsPanel({
  serverId,
}: ServerInboundsPanelProps): React.ReactElement {
  const { data, isPending, isError } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: () => listNodes(),
  });
  const nodes = data && filterNodesByServer(data, serverId);

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{m.admin_servers_inbounds_title()}</h2>
          <p className="text-xs text-muted-foreground">
            {m.admin_servers_inbounds_description()}
          </p>
        </div>
        <div className="flex gap-2">
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
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {m.admin_proxies_servers_nodes_error()}
        </p>
      ) : nodes && nodes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {nodes.map((node) => (
            <li
              key={node.id}
              className="flex items-center gap-2 rounded-lg border bg-muted/20 p-2"
            >
              <Link
                to="/admin/servers/$serverId/inbounds/$nodeId"
                params={{ serverId, nodeId: node.id }}
                className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline"
              >
                {node.name}
              </Link>
              <span className="font-mono text-xs text-muted-foreground">
                {node.resolvedAddress}:{node.listenPort}
              </span>
              <Badge variant="outline">{node.protocol}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {m.admin_proxies_servers_nodes_empty()}
        </p>
      )}
    </section>
  );
}
