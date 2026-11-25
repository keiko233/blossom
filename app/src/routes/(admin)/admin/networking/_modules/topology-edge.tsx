import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type React from "react";
import { createContext, useContext } from "react";

import { StatusDot } from "@/components/ui/status-dot";
import type { TopologyGraphEdgeData } from "@/lib/networking-topology";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

import {
  EDGE_DASH_ARRAY,
  EDGE_TONE_COLOR,
  HEALTH_LABEL,
  PHASE_LABEL,
} from "./topology-labels";

export type TopologyLinkEdge = Edge<
  TopologyGraphEdgeData & Record<string, unknown>,
  "link"
>;

/** Selection sink for edge labels, which render outside the edge's `<g>`. */
export const TopologySelectionContext = createContext<
  ((linkId: string) => void) | null
>(null);

/**
 * A managed link. Stroke, dash and opacity go through `style` because SVG
 * presentation attributes do not resolve `var()`; the arrowhead is one of the
 * graph's own `<marker>` definitions, referenced by id string.
 */
export function TopologyLinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<TopologyLinkEdge>): React.ReactElement | null {
  const onSelectLink = useContext(TopologySelectionContext);

  if (!data) return null;

  const span = data.parallelCount - 1;
  const offset = 24 + 12 * (data.parallelIndex - span / 2);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 10,
    offset,
  });
  const color = EDGE_TONE_COLOR[data.style.tone];
  const label = m.admin_networking_topology_wb_edge_label({
    source: data.sourceServerName,
    destination: data.destinationServerName,
    inbound: data.destinationInboundName,
    protocol: data.protocol,
  });
  const description = `${label}, ${PHASE_LABEL[data.phase]()}, ${HEALTH_LABEL[data.health]()}`;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: selected ? data.style.width + 0.5 : data.style.width,
          strokeDasharray: EDGE_DASH_ARRAY[data.style.dash],
          opacity: data.dimmed ? 0.3 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cn(
            "nodrag nopan pointer-events-auto absolute flex items-center gap-1.5",
            "rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs",
            "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
            "data-[dimmed=true]:opacity-40",
            selected && "ring-2 ring-ring/24",
          )}
          data-slot="topology-edge-label"
          data-dimmed={data.dimmed}
          data-selected={selected}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          aria-label={description}
          aria-pressed={selected}
          onClick={() => onSelectLink?.(data.linkId)}
        >
          <StatusDot tone={data.style.tone} />
          <span>{data.protocol}</span>
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
