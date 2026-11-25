import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import type { TopologyGraphNodeData } from "@/lib/networking-topology";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export type TopologyServerNode = Node<TopologyGraphNodeData, "server">;

export function TopologyServerNode({
  data,
}: NodeProps<TopologyServerNode>): React.ReactElement {
  return (
    <div
      data-slot="topology-server-node"
      data-selected={data.selected}
      data-dimmed={data.dimmed}
      data-enabled={data.enabled}
      aria-hidden
      className={cn(
        "flex h-16 w-56 flex-col justify-center gap-1 rounded-lg border bg-card px-3 text-card-foreground",
        "transition-colors data-[selected=true]:border-ring data-[selected=true]:ring-2 data-[selected=true]:ring-ring/24",
        "data-[dimmed=true]:opacity-40 data-[enabled=false]:bg-muted/40",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="size-1.5"
      />
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={data.tone} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {data.name}
        </span>
        {!data.enabled ? (
          <Badge size="sm" variant="warning">
            {m.admin_networking_topology_server_disabled()}
          </Badge>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {m.admin_networking_topology_wb_node_counts({
          incoming: data.incoming,
          outgoing: data.outgoing,
        })}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="size-1.5"
      />
    </div>
  );
}
