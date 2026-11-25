import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import type React from "react";
import { useEffect, useLayoutEffect, useState } from "react";

import type {
  TopologyGraph,
  TopologyGraphNodeData,
  TopologySelection,
} from "@/lib/networking-topology";
import {
  TOPOLOGY_NODE_HEIGHT,
  TOPOLOGY_NODE_WIDTH,
} from "@/lib/networking-topology-layout";
import type { TopologyPosition } from "@/lib/topology-positions";
import { m } from "@/paraglide/messages";

import { TopologyLinkEdge, TopologySelectionContext } from "./topology-edge";
import { EDGE_TONE_COLOR, HEALTH_LABEL, PHASE_LABEL } from "./topology-labels";
import { TopologyServerNode } from "./topology-node";

const EDGE_TONES = ["success", "info", "warning", "danger", "muted"] as const;

/**
 * SVG presentation attributes cannot read `var()`, so the arrowheads are
 * plain `<marker>` elements styled through CSS custom properties. Edges
 * reference them by id string; the library then emits `url('#id')` without
 * defining its own marker (it only generates one for object markers).
 */
function EdgeMarkers(): React.ReactElement {
  return (
    <svg aria-hidden className="pointer-events-none absolute size-0">
      <defs>
        {EDGE_TONES.map((tone) => (
          <marker
            id={`blossom-arrow-${tone}`}
            key={tone}
            markerHeight="12.5"
            markerUnits="strokeWidth"
            markerWidth="12.5"
            orient="auto-start-reverse"
            refX="0"
            refY="0"
            viewBox="-10 -10 20 20"
          >
            <polyline
              points="-5,-4 0,0 -5,4 -5,-4"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                stroke: EDGE_TONE_COLOR[tone],
                fill: EDGE_TONE_COLOR[tone],
              }}
            />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

/** Imperative handles the toolbar needs from the canvas. */
export interface TopologyGraphApi {
  fitView: () => void;
  fitViewSoon: () => void;
}

export interface TopologyGraphProps {
  graph: TopologyGraph;
  positions: ReadonlyMap<string, TopologyPosition>;
  /** Bumped when Auto-layout discards drags, so live drags reset with it. */
  layoutEpoch: number;
  onSelectionChange: (selection: TopologySelection | null) => void;
  onPositionsChange: (
    changes: readonly { id: string; position: TopologyPosition }[],
  ) => void;
  apiRef: React.RefObject<TopologyGraphApi | null>;
}

const nodeTypes: NodeTypes = { server: TopologyServerNode };
const edgeTypes: EdgeTypes = { link: TopologyLinkEdge };
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1, duration: 150 };

function buildNodes(
  graph: TopologyGraph,
  positions: ReadonlyMap<string, TopologyPosition>,
): Node[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: "server",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: node.data,
    width: TOPOLOGY_NODE_WIDTH,
    height: TOPOLOGY_NODE_HEIGHT,
    ariaLabel: nodeAriaLabel(node.data),
    selected: node.data.selected,
  }));
}

function nodeAriaLabel(data: TopologyGraphNodeData): string {
  const counts = m.admin_networking_topology_wb_node_counts({
    incoming: data.incoming,
    outgoing: data.outgoing,
  });
  return data.enabled
    ? `${data.name}, ${counts}`
    : `${data.name}, ${m.admin_networking_topology_server_disabled()}, ${counts}`;
}

function buildEdges(graph: TopologyGraph): Edge[] {
  return graph.edges.map((edge) => {
    const route = m.admin_networking_topology_wb_edge_label({
      source: edge.data.sourceServerName,
      destination: edge.data.destinationServerName,
      inbound: edge.data.destinationInboundName,
      protocol: edge.data.protocol,
    });
    return {
      id: edge.id,
      type: "link",
      source: edge.source,
      target: edge.target,
      data: edge.data,
      selected: edge.data.selected,
      markerEnd: `blossom-arrow-${edge.data.style.tone}`,
      className: edge.data.style.animated ? "blossom-edge-active" : undefined,
      ariaLabel: `${route}, ${PHASE_LABEL[edge.data.phase]()}, ${HEALTH_LABEL[edge.data.health]()}`,
    };
  });
}

function TopologyFlow({
  graph,
  positions,
  layoutEpoch,
  onSelectionChange,
  onPositionsChange,
  apiRef,
}: TopologyGraphProps): React.ReactElement {
  const reactFlow = useReactFlow();
  // A controlled flow needs local node state so React Flow can apply drag
  // offsets. The state is rebuilt only when the graph data or the persisted
  // positions change, so selection-only re-renders keep in-progress drags and
  // a periodic refetch never moves a node the operator just placed.
  const dataKey = JSON.stringify([graph, [...positions]]) + layoutEpoch;
  const [nodes, setNodes] = useState<Node[]>(() =>
    buildNodes(graph, positions),
  );
  const edges = buildEdges(graph);
  const showMiniMap = graph.nodes.length > 12;

  // Layout effect so a pending `fitViewSoon` (scheduled after this commit's
  // paint) sees the rebuilt node positions instead of the previous layout.
  useLayoutEffect(() => {
    setNodes(buildNodes(graph, positions));
    // `dataKey` captures the graph and the effective positions.
  }, [dataKey]);

  useEffect(() => {
    apiRef.current = {
      fitView: () => {
        void reactFlow.fitView(FIT_VIEW_OPTIONS);
      },
      fitViewSoon: () => {
        requestAnimationFrame(() => {
          void reactFlow.fitView(FIT_VIEW_OPTIONS);
        });
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, reactFlow]);

  const selectLink = (linkId: string) => {
    onSelectionChange({ kind: "link", id: linkId });
  };

  return (
    <TopologySelectionContext.Provider value={selectLink}>
      <ReactFlow
        aria-label={m.admin_networking_topology_wb_canvas_label()}
        attributionPosition="bottom-center"
        className="bg-background"
        forceColorMode="light"
        edgeTypes={edgeTypes}
        edges={edges}
        elementsSelectable
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        maxZoom={1.5}
        minZoom={0.25}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable
        nodesFocusable
        onEdgeClick={(_event, edge) => selectLink(edge.id)}
        onNodesChange={(changes) => {
          setNodes((current) => changes.applyTo(current));
          const [selected] = changes.getByType("select");
          if (selected?.selected) {
            onSelectionChange({ kind: "server", id: selected.id });
          }
        }}
        onNodeClick={(_event, node) =>
          onSelectionChange({ kind: "server", id: node.id })
        }
        onNodeDragStop={(_event, node) => {
          const position = { x: node.position.x, y: node.position.y };
          onPositionsChange([{ id: node.id, position }]);
        }}
        onPaneClick={() => onSelectionChange(null)}
      >
        <EdgeMarkers />
        <Background gap={20} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} position="bottom-left" />
        {showMiniMap ? (
          <MiniMap
            className="hidden 2xl:block"
            pannable
            zoomable
            position="bottom-right"
          />
        ) : null}
      </ReactFlow>
    </TopologySelectionContext.Provider>
  );
}

/**
 * Client-only interactive canvas. Loaded through `React.lazy` so the React
 * Flow bundle never runs during SSR. Every node carries an explicit
 * `width`/`height` from the layout constants, so the first paint and
 * `fitView` need no measure pass.
 */
export default function TopologyGraph(
  props: TopologyGraphProps,
): React.ReactElement {
  return (
    <ReactFlowProvider>
      <TopologyFlow {...props} />
    </ReactFlowProvider>
  );
}
