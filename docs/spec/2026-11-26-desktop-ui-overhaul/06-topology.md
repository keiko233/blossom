# 06 Topology workbench (worker D, Wave 2)

Goal: replace the grid of server cards with a real interactive graph on `@xyflow/react`, inside a full-bleed workbench: toolbar, canvas, docked inspector rail, status bar. Requires W1 merged (it adds the dependency, the React Flow theming and the workbench primitives). Read [UI design standard](../../development/ui-design.md) first.

## Files

Create (under `app/src/routes/(admin)/admin/networking/_modules/` unless noted):

- `topology-workbench.tsx` (composition, view state, keyboard)
- `topology-graph.tsx` (React Flow canvas, lazy-loaded)
- `topology-node.tsx` (`TopologyServerNode`), `topology-edge.tsx` (`TopologyLinkEdge`)
- `topology-toolbar.tsx`, `topology-legend.tsx`, `topology-rail.tsx`
- `app/src/lib/networking-topology-layout.ts` + `networking-topology-layout.test.ts`
- `app/src/lib/topology-positions.ts` + `topology-positions.test.ts`

Modify:

- `networking/topology.tsx` (root becomes `WorkbenchViewport`)
- `_modules/topology-canvas.tsx` (delete; replaced by `topology-graph.tsx`. Keep the `PHASE_LABEL`/`HEALTH_LABEL` maps by moving them to `topology-labels.ts`)
- `_modules/topology-inspector.tsx`, `topology-list.tsx` (flat, no cards, no `NetworkingSection`)
- `_modules/networking-rollouts.tsx` (flat; becomes the rail's Rollouts tab)
- `app/src/lib/networking-topology.ts` + `networking-topology.test.ts` (graph model, edge style, matching)
- i18n: prefix `admin_networking_topology_wb_`, inserted after `admin_networking_topology_summary` in both locales

Do not use `NetworkingSection` (worker F is rewriting it). Do not edit `use-networking-workspace.ts`, `query/networking*.ts` or the link editor dialog (the "Add link" action links to `/admin/networking/links` exactly as today).

## Compatibility and theming (verified facts and required checks)

- `@xyflow/react@13.0.3` (installed by W1): peers `react >=18`, `react-dom >=18`; ESM only; `sideEffects: ["*.css"]`; exports `style.css`, `base.css`, `xy-theme.css`; Node ≥ 20. Vite 8 needs no special handling for ESM-only packages. Tailwind v4 coexists because the library ships plain CSS, imported once in `styles.css` by W1, with every `--xy-*` variable mapped to Blossom tokens. Confirm in the PR that light and dark both render with no hard-coded colors in your components and that the Cloudflare build (`pnpm build`) succeeds.
- The graph is **client only**: `TopologyGraph` is loaded with `React.lazy(() => import("./topology-graph"))` inside `<ClientOnly fallback={<WorkbenchSkeleton variant="topology" />}>` (from `@tanstack/react-router`) and `<Suspense>`. The route has no loader, so SSR renders the pending skeleton anyway; the `ClientOnly` guard is a safety net, because React Flow only renders nodes that have a width and height. Give every node explicit `width`/`height` (the layout constants) so the first client paint and `fitView` do not need a measure pass.
- Pass the library's fixed light color mode (check the prop name in `node_modules/@xyflow/react/dist/esm/...d.ts`; it is `colorMode` in 12.x) and rely on W1's token overrides for both themes, because Blossom switches themes with `.dark` on `html`, not with the library's mode class.
- SVG presentation attributes do not resolve `var()`. Edge `stroke`/`strokeDasharray` go through `style`, which does. For the arrow marker, first try `markerEnd={{ type: MarkerType.ArrowClosed, color: "var(--success)" }}`; if the marker renders black, define your own `<marker>` elements once in the graph (`<svg><defs>…</defs></svg>` with `style={{ fill: "var(--x)" }}`, one per tone) and reference them as `markerEnd="url(#blossom-arrow-success)"`. Record which path worked in the PR.

## Route and workbench structure

`topology.tsx`:

```tsx
function RouteComponent(): React.ReactElement {
  const { data, isPending, isError, refetch } = useNetworkingWorkspace();
  return (
    <WorkbenchViewport data-slot="topology-workbench">
      {isPending ? (
        <WorkbenchSkeleton variant="topology" />
      ) : isError || !data ? (
        <TopologyLoadError onRetry={() => void refetch()} />
      ) : (
        <TopologyWorkbench data={data} />
      )}
    </WorkbenchViewport>
  );
}
```

`TopologyLoadError` is a compact `Empty` filling the pane with the existing `m.admin_networking_load_error()` and `m.admin_networking_action_retry()`. There is no `PageHeader`: the Networking sidebar already shows the active section.

`TopologyWorkbench` (state: `query`, `view: "graph" | "list"`, `selection`, `railOpen`, a `ReactFlowInstance` ref):

```text
┌ topology-toolbar (WorkbenchBar h-10) ────────────────────────────────────────────────────────────┐
│ [🔍 Search servers…  /] [Graph|List] [⤢ Fit] [⟲ Auto-layout] [Legend ▾]   5 servers · 7 links  [＋ Add link] [▮ Rail] │
├ activation notice (only when activation is disabled; h-8, one line, text-xs, bg-info/8) ─────────┤
├ workbench-body ──────────────────────────────────────────────────────────────────────────────────┤
│ ┌ workbench-canvas (flex-1 min-h-0) ───────────────────────┐ ┌ workbench-rail (w-88, lg+) ────┐ │
│ │  Graph: <ReactFlow …/>      List: <TopologyList/>         │ │ [Inspector | Rollouts] tabs     │ │
│ │                                                           │ │ own scroll                      │ │
│ └───────────────────────────────────────────────────────────┘ └────────────────────────────────┘ │
├ workbench-status-bar ────────────────────────────────────────────────────────────────────────────┤
│ ● 5 servers · 7 links · 1 degraded · 2 pending            / search · F fit · Esc clear · ] rail  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Empty (no servers)**: compact `Empty` in the canvas (`m.admin_networking_no_servers()`), toolbar controls disabled except Add link.
- **Rail**: `WorkbenchRail` (22rem) from `lg`; below `lg` the same content opens in a right `Sheet` when a selection is made (and from the toolbar button). The rail contains `Tabs variant="underline"` (`Inspector` | `Rollouts`) with `TabsPanel`s; the panel content is the one scroller. Collapsed state is a per-viewer preference (`blossom.topology.rail.v1`, see below). Selecting a node or edge opens the rail if closed and switches to Inspector.
- **Toolbar controls** (all `size="xs"`/`sm`, icon buttons have `aria-label` + `Tooltip` + `Kbd`):
  1. Search: `InputGroup` with `SearchIcon` and a `/` `Kbd`; `value`/`onValueChange` drive `query`; `type="search"`, `aria-label={m.admin_networking_topology_search_label()}`.
  2. View toggle: `ToggleGroup` (single, `Graph | List`) with `aria-label`; the list is the accessible equivalent of the canvas and also the narrow-screen default (`<md` starts in List).
  3. Fit view: `reactFlow.fitView({ padding: 0.2, maxZoom: 1, duration: 150 })`; disabled in List view.
  4. Auto-layout: clears persisted positions and recomputes `layoutLayered`, then fits.
  5. Legend: `Popover` (`topology-legend.tsx`) listing every edge style with a 40px sample line, generated from the same `linkEdgeStyle` table the edges use (so the legend cannot drift).
  6. Summary text: `m.admin_networking_topology_wb_summary({ servers, links })` (`text-xs text-muted-foreground tabular-nums`, hidden below `xl`).
  7. Add link: `Button size="sm" render={<Link to="/admin/networking/links" />}` with `PlusIcon`.
  8. Rail toggle: `Button variant="ghost" size="icon-xs"` (`PanelRightIcon`), `aria-pressed`, `aria-keyshortcuts="]"`.
- **Status bar**: counts for servers, links, degraded/failed links, pending/applying links (from `data.links`), and the shortcut legend (hidden below `xl`).
- **Keyboard** (active when focus is inside the workbench and not in a text field): `/` focuses search, `Esc` clears the selection (and blurs search if focused), `F` fits the view, `]` toggles the rail, `G`/`L` are not bound (use the toggle). In List view the existing `moveTopologySelection`/`topologySelectionOrder` arrow-key model is retained.

## Graph model (`lib/networking-topology.ts`, pure and xyflow-free)

Add, with tests:

```ts
export type EdgeTone = "success" | "info" | "warning" | "danger" | "muted";
export interface LinkEdgeStyle {
  tone: EdgeTone;
  dash: "solid" | "dashed" | "dotted";
  width: 1.5 | 2;
  animated: boolean;           // only in-flight work: applying, removing
}
export function linkEdgeStyle(phase: TopologyLinkPhase, health: TopologyLinkHealth): LinkEdgeStyle;
export const TOPOLOGY_EDGE_LEGEND: readonly { key: string; style: LinkEdgeStyle }[];

export interface TopologyGraphNodeData { serverId: string; name: string; enabled: boolean; tone: "success"|"warning"|"danger"|"muted"; incoming: number; outgoing: number; selected: boolean; dimmed: boolean }
export interface TopologyGraphEdgeData { linkId: string; protocol: PeerProtocol; style: LinkEdgeStyle; phase; health; destinationInboundName: string; selected: boolean; dimmed: boolean; parallelIndex: number; parallelCount: number }
export interface TopologyGraph { nodes: { id: string; data: TopologyGraphNodeData }[]; edges: { id: string; source: string; target: string; data: TopologyGraphEdgeData }[] }

export function matchedServerIds(list: TopologyList, query: string): ReadonlySet<string> | null; // null when the query is empty
export function buildTopologyGraph(input: TopologyInput, list: TopologyList, selection: TopologySelection | null, matched: ReadonlySet<string> | null, runtime?: ReadonlyMap<string, { runtimeState: string; configState: string }>): TopologyGraph;
```

`linkEdgeStyle` table (single source of truth for edges, legend and tests):

| Phase / health         | Tone    | Dash   | Width | Animated |
| ---------------------- | ------- | ------ | ----- | -------- |
| `failed`               | danger  | solid  | 2     | no       |
| `stalled`              | warning | dashed | 1.5   | no       |
| `applied` + `degraded` | warning | solid  | 2     | no       |
| `applied` + `healthy`  | success | solid  | 1.5   | no       |
| `applied` + `unknown`  | muted   | solid  | 1.5   | no       |
| `pending`              | info    | dashed | 1.5   | no       |
| `applying`             | info    | dashed | 1.5   | yes      |
| `removing`             | muted   | dashed | 1.5   | yes      |
| `draft`                | muted   | dotted | 1.5   | no       |

`dimmed` nodes are the ones not in `matched` when a query is active (they stay visible but at `opacity-40`); an edge is dimmed when neither endpoint matches. Links whose source or destination does not resolve (`list.unresolvedLinkIds`) are omitted from the graph and counted in the status bar. `parallelIndex/Count` number links that share the same ordered server pair so the edge component can offset them. The server node `tone` comes from `enabled` and the runtime/config state values already present on `NetworkingWorkspaceData.servers` (read `query/networking-read.ts` for the real enumerations; unknown values map to `muted`, an `error`-like state to `danger`, a `degraded`/pending config state to `warning`, otherwise `success`; disabled is always `muted`).

Tests (`networking-topology.test.ts`, extending the existing file): `linkEdgeStyle` exhaustively for every phase × health pair (no throw, matches the table, `animated` only for applying/removing), `TOPOLOGY_EDGE_LEGEND` contains every distinct style, `matchedServerIds` (empty query → null; name match; link-only match), `buildTopologyGraph` (counts, parallel indices for two links between one pair, dim sets, selection flags for server and link, unresolved links omitted).

## Layout algorithm (`lib/networking-topology-layout.ts`)

Pure, deterministic, dependency-free layered layout, left to right.

```ts
export interface LayoutNode {
  id: string;
  name: string;
}
export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}
export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
} // 224, 64, 96, 32
export interface LayoutResult {
  positions: ReadonlyMap<string, { x: number; y: number }>;
  width: number;
  height: number;
}
export function layoutLayered(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options?: LayoutOptions,
): LayoutResult;
```

Algorithm (all tie-breaks by `name.localeCompare` then `id`, never by input order or `Math.random`):

1. Drop edges whose endpoints are unknown and self-loops; collapse parallel edges to a unique directed pair set.
2. **Components**: weakly connected components; isolated nodes (degree 0) are set aside.
3. **Cycle breaking** per component: DFS from nodes in sorted order; an edge to a node on the current stack is a back edge and is reversed for layering only (rendering keeps the true direction).
4. **Layering**: longest-path layering on the resulting DAG (`layer(v) = max(layer(u) + 1)` over predecessors, sources at 0).
5. **Ordering**: within each layer, 4 alternating barycenter sweeps (down, up, down, up) using the neighbor positions in the adjacent layer; initial order is sorted by name; ties by name then id.
6. **Coordinates**: `x = layer × (nodeWidth + gapX)`; within a layer nodes stack with `gapY`, and each layer is vertically centered against the tallest layer of its component. Components stack top to bottom with `2 × gapY` between them.
7. **Isolated nodes** form a grid below the components: `columns = max(1, floor(componentWidth / (nodeWidth + gapX)))` (at least 4 when there are no components), sorted by name.
8. Return integer positions and the bounding `width`/`height`.

Tests (`networking-topology-layout.test.ts`): empty input; single node; chain A→B→C gets layers 0/1/2 with increasing `x`; diamond; two-node cycle A↔B terminates and keeps both nodes at different layers; self-loop and unknown-endpoint edges ignored; parallel edges do not change positions; **determinism**: ten seeded shuffles of the same graph yield identical positions; isolated nodes are in the grid below and never overlap components; **no overlap**: pairwise bounding boxes of a 60-node random graph (seeded PRNG) are disjoint; a 200-node graph lays out in under 100 ms (`performance.now()` budget with generous slack, skip the assertion when `process.env.CI_SLOW` is set); stability: adding an isolated node does not move any other node.

## Node and edge components

`TopologyServerNode` (`data-slot="topology-server-node"`, registered as `nodeTypes = { server: TopologyServerNode }` at module scope):

```tsx
<div
  data-slot="topology-server-node"
  data-selected={data.selected}
  data-dimmed={data.dimmed}
  data-enabled={data.enabled}
  className={cn(
    "flex h-16 w-56 flex-col justify-center gap-1 rounded-lg border bg-card px-3 text-card-foreground",
    "transition-colors data-[selected=true]:border-ring data-[selected=true]:ring-2 data-[selected=true]:ring-ring/24",
    "data-[dimmed=true]:opacity-40 data-[enabled=false]:bg-muted/40",
  )}
>
  <Handle type="target" position={Position.Left} isConnectable={false} />
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
  <Handle type="source" position={Position.Right} isConnectable={false} />
</div>
```

Handles are 6px dots using `--xy-handle-*` tokens (set by W1), never `!important` color overrides. The node is focusable (`nodesFocusable`), has `aria-label` (name, enabled state, counts) and Enter/Space select it (library behavior; verify).

`TopologyLinkEdge` (registered as `edgeTypes = { link: TopologyLinkEdge }`): path from `getSmoothStepPath({ borderRadius: 10, offset: 24 + 12 × (parallelIndex - (parallelCount - 1) / 2) })`; `BaseEdge` with `style={{ stroke: "var(--<tone token>)", strokeWidth, strokeDasharray }}` (dash `6 4`, dotted `2 4`, solid none), `className="blossom-edge-active"` when animated, arrow marker per the compatibility note, opacity `0.3` when dimmed, `+0.5` width when selected. The label is rendered with `EdgeLabelRenderer` as a real `button` (`nodrag nopan pointer-events-auto absolute`, `rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs`) showing a `StatusDot` and the protocol (`vless`, `trojan`, …); `aria-label` reads "<source> → <destination> via <inbound> (<protocol>), <phase>, <health>"; click and Enter select the link (`onEdgeClick` also selects). Selected state: label `ring-2 ring-ring/24`.

`TopologyGraph` props: `graph: TopologyGraph`, `positions: Map`, `selection`, `onSelection`, `onPositionsChange`, `apiRef`. Settings: `nodesConnectable={false}`, `nodesDraggable`, `elementsSelectable`, `fitView`, `minZoom={0.25}`, `maxZoom={1.5}`, `proOptions` per W1's attribution decision, `aria-label={m.admin_networking_topology_canvas_label()}`, `<Background variant={BackgroundVariant.Dots} gap={20} size={1} />`, `<Controls showInteractive={false} position="bottom-left" />`. `<MiniMap>` only when there are more than 12 nodes and from `2xl`. A pane click clears the selection. Node drags persist through `onNodeDragStop`.

## Per-viewer preferences (`lib/topology-positions.ts`)

Keys `blossom.topology.positions.v1` (a `Record<serverId, { x: number; y: number }>`) and `blossom.topology.rail.v1` (`"open" | "closed"`). Functions take an injected `Storage`-like object so they are testable: `readTopologyPositions(storage, knownIds)` (drops unknown ids and non-finite numbers, never throws), `writeTopologyPositions(storage, positions)` (try/catch), `clearTopologyPositions(storage)`, `readRailState`, `writeRailState`. Effective position = persisted position if present and the node is known, otherwise the layout position; Auto-layout clears the persisted map. Tests: round trip, pruning of removed servers, garbage JSON, throwing storage, non-numeric coordinates.

## Remaining restyle work in this pass

- `TopologyInspector`: same content, flat sections with `SectionHeader`, a `dl` grid (`grid-cols-[7rem_minmax(0,1fr)]`), `InspectorSkeleton` while any dependent data is missing; link details include Edit link (`/admin/networking/links?link=<id>` as today).
- `TopologyList`: a dense table (`Table`, rows `h-9`: Server, State, Outgoing, Incoming, Phase, Health) inside the canvas region as its single scroller; row click and keyboard selection feed the shared `selection`.
- `NetworkingRollouts`: flat list/table in the Rollouts tab; no card; `Spinner` only inside action buttons.
- Remove the page-level description paragraphs (`admin_networking_topology_description`, `…_canvas_description`, `…_list_section_description` keys may stay unused; do not delete keys other pages use).

## Verification

```bash
pnpm --filter @blossom/app exec vitest run src/lib/networking-topology.test.ts src/lib/networking-topology-layout.test.ts src/lib/topology-positions.test.ts
pnpm --filter @blossom/app exec tsc --noEmit
pnpm fmt && pnpm lint && pnpm test
pnpm build && pnpm --filter @blossom/app build:node
```

Manual QA (preview tools with a database seeded with 5+ servers and a mix of link phases): no outer scrollbar or padding; fit view on load; pan, zoom, drag nodes and reload (positions persist); Auto-layout restores the computed layout; search dims non-matching nodes and filters the list view; selecting a node or edge fills the rail; `Esc` clears; below `lg` the rail opens as a `Sheet`; applying/removing edges animate only when `prefers-reduced-motion` is not set; every edge style is visible in light and dark and matches the Legend; keyboard-only: Tab reaches search, toggle, canvas nodes and edge labels, and the List view offers the same selection.
