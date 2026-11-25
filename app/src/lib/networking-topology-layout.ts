/**
 * Deterministic layered layout for the interactive topology graph. Pure and
 * dependency-free so it runs on the server, in the browser and in tests: it
 * takes node names and directed edges and returns integer positions.
 *
 * The algorithm is a small Sugiyama variant, left to right: break cycles,
 * layer by longest path, order each layer with barycenter sweeps, then assign
 * coordinates. Every tie is broken by `name` and then `id`, never by input
 * order, so shuffling the input cannot move the result.
 */

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
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: ReadonlyMap<string, LayoutPoint>;
  width: number;
  height: number;
}

interface DirectedPair {
  source: string;
  target: string;
}

/** Node box the layout assumes, matched by the rendered node component. */
export const TOPOLOGY_NODE_WIDTH = 224;
export const TOPOLOGY_NODE_HEIGHT = 64;
export const TOPOLOGY_GAP_X = 96;
export const TOPOLOGY_GAP_Y = 32;

const ORDER_SWEEPS = 4;
const ISOLATED_COLUMNS_WITHOUT_COMPONENTS = 4;

function compareIds(
  a: string,
  b: string,
  byId: ReadonlyMap<string, LayoutNode>,
): number {
  const left = byId.get(a);
  const right = byId.get(b);
  if (left && right) {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) return byName;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortIds(
  ids: Iterable<string>,
  byId: ReadonlyMap<string, LayoutNode>,
): string[] {
  return [...ids].sort((a, b) => compareIds(a, b, byId));
}

/** Collapses parallel edges and drops self-loops and unknown endpoints. */
function collectPairs(
  knownIds: ReadonlySet<string>,
  edges: readonly LayoutEdge[],
): DirectedPair[] {
  const pairs = new Map<string, DirectedPair>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!knownIds.has(edge.source) || !knownIds.has(edge.target)) continue;
    pairs.set(`${edge.source}\u0000${edge.target}`, {
      source: edge.source,
      target: edge.target,
    });
  }
  return [...pairs.values()];
}

function buildAdjacency(
  knownIds: ReadonlySet<string>,
  pairs: readonly DirectedPair[],
  undirected: boolean,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const id of knownIds) adjacency.set(id, new Set());
  for (const pair of pairs) {
    adjacency.get(pair.source)?.add(pair.target);
    const reverse = undirected ? pair.target : undefined;
    if (reverse !== undefined) adjacency.get(reverse)?.add(pair.source);
  }
  return adjacency;
}

function findComponents(
  connected: readonly string[],
  byId: ReadonlyMap<string, LayoutNode>,
  neighbors: ReadonlyMap<string, Set<string>>,
): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const root of connected) {
    if (seen.has(root)) continue;
    const stack = [root];
    const component: string[] = [];
    seen.add(root);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      component.push(id);
      const adjacent = sortIds(neighbors.get(id) ?? [], byId);
      for (const next of adjacent) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(sortIds(component, byId));
  }
  return components.sort((a, b) => compareIds(a[0], b[0], byId));
}

/**
 * DFS cycle breaking: an edge that points at a node still on the recursion
 * stack is a back edge and is reversed for layering only.
 */
function reverseBackEdges(
  ids: readonly string[],
  pairs: readonly DirectedPair[],
  byId: ReadonlyMap<string, LayoutNode>,
): Set<string> {
  const outgoing = buildAdjacency(new Set(ids), pairs, false);
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of ids) color.set(id, 0);
  const reversed = new Set<string>();

  for (const root of sortIds(ids, byId)) {
    if (color.get(root) !== 0) continue;
    color.set(root, 1);
    const stack: { id: string; index: number; next: string[] }[] = [
      { id: root, index: 0, next: sortIds(outgoing.get(root) ?? [], byId) },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.next.length) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }

      const target = frame.next[frame.index];
      frame.index += 1;
      const targetColor = color.get(target) ?? 0;
      if (targetColor === 1) {
        reversed.add(`${frame.id}\u0000${target}`);
      } else if (targetColor === 0) {
        color.set(target, 1);
        stack.push({
          id: target,
          index: 0,
          next: sortIds(outgoing.get(target) ?? [], byId),
        });
      }
    }
  }

  return reversed;
}

function layerNodes(
  ids: readonly string[],
  pairs: readonly DirectedPair[],
  reversed: ReadonlySet<string>,
  byId: ReadonlyMap<string, LayoutNode>,
): string[][] {
  const dag = new Map<string, DirectedPair>();
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);

  for (const pair of pairs) {
    const edge = reversed.has(`${pair.source}\u0000${pair.target}`)
      ? { source: pair.target, target: pair.source }
      : pair;
    const key = `${edge.source}\u0000${edge.target}`;
    if (dag.has(key)) continue;
    dag.set(key, edge);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of dag.values()) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }

  const layer = new Map<string, number>();
  for (const id of ids) layer.set(id, 0);
  const ready = sortIds(
    ids.filter((id) => (indegree.get(id) ?? 0) === 0),
    byId,
  );
  const queue = [...ready];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const target of sortIds(outgoing.get(id) ?? [], byId)) {
      layer.set(
        target,
        Math.max(layer.get(target) ?? 0, (layer.get(id) ?? 0) + 1),
      );
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  const layers: string[][] = [];
  for (const id of ids) {
    const index = layer.get(id) ?? 0;
    while (layers.length <= index) layers.push([]);
    layers[index].push(id);
  }
  for (const nodesInLayer of layers) {
    nodesInLayer.sort((a, b) => compareIds(a, b, byId));
  }
  return layers;
}

function orderLayers(
  layers: string[][],
  pairs: readonly DirectedPair[],
  reverseKeys: ReadonlySet<string>,
  byId: ReadonlyMap<string, LayoutNode>,
): void {
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const pair of pairs) {
    const edge = reverseKeys.has(`${pair.source}\u0000${pair.target}`)
      ? { source: pair.target, target: pair.source }
      : pair;
    predecessors.set(edge.target, [
      ...(predecessors.get(edge.target) ?? []),
      edge.source,
    ]);
    successors.set(edge.source, [
      ...(successors.get(edge.source) ?? []),
      edge.target,
    ]);
  }

  const sweep = (downward: boolean) => {
    const indices = layers.map((_, index) => index);
    const order = downward ? indices : indices.reverse();
    for (const index of order) {
      const adjacentIndex = downward ? index - 1 : index + 1;
      const adjacent = layers[adjacentIndex];
      if (!adjacent) continue;
      const slots = new Map(adjacent.map((id, slot) => [id, slot]));
      const neighbours = downward ? predecessors : successors;
      const current = layers[index];
      const scored = current.map((id, slot) => {
        const positions = (neighbours.get(id) ?? [])
          .map((neighbour) => slots.get(neighbour))
          .filter((slot): slot is number => slot !== undefined);
        const barycenter =
          positions.length === 0
            ? slot
            : positions.reduce((sum, value) => sum + value, 0) /
              positions.length;
        return { barycenter, id };
      });
      scored.sort(
        (a, b) => a.barycenter - b.barycenter || compareIds(a.id, b.id, byId),
      );
      layers[index] = scored.map((item) => item.id);
    }
  };

  for (let step = 0; step < ORDER_SWEEPS; step += 1) {
    sweep(step % 2 === 0);
  }
}

interface ComponentLayout {
  positions: Map<string, LayoutPoint>;
  width: number;
  height: number;
}

function computeComponentLayout(
  ids: readonly string[],
  pairs: readonly DirectedPair[],
  byId: ReadonlyMap<string, LayoutNode>,
  nodeWidth: number,
  nodeHeight: number,
  gapX: number,
  gapY: number,
): ComponentLayout {
  const componentPairs = pairs.filter(
    (pair) =>
      ids.includes(pair.source) &&
      ids.includes(pair.target) &&
      pair.source !== pair.target,
  );
  const reversed = reverseBackEdges(ids, componentPairs, byId);
  const layers = layerNodes(ids, componentPairs, reversed, byId);
  orderLayers(layers, componentPairs, reversed, byId);

  const layerHeights = layers.map(
    (nodes) => nodes.length * nodeHeight + Math.max(0, nodes.length - 1) * gapY,
  );
  const tallest = Math.max(0, ...layerHeights);
  const positions = new Map<string, LayoutPoint>();

  layers.forEach((nodes, layerIndex) => {
    const offsetY = (tallest - layerHeights[layerIndex]) / 2;
    nodes.forEach((id, slot) => {
      positions.set(id, {
        x: Math.round(layerIndex * (nodeWidth + gapX)),
        y: Math.round(offsetY + slot * (nodeHeight + gapY)),
      });
    });
  });

  return {
    positions,
    width: Math.max(0, (layers.length - 1) * (nodeWidth + gapX) + nodeWidth),
    height: tallest,
  };
}

export function layoutLayered(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): LayoutResult {
  const nodeWidth = options.nodeWidth ?? TOPOLOGY_NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? TOPOLOGY_NODE_HEIGHT;
  const gapX = options.gapX ?? TOPOLOGY_GAP_X;
  const gapY = options.gapY ?? TOPOLOGY_GAP_Y;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const knownIds = new Set(byId.keys());
  const pairs = collectPairs(knownIds, edges);
  const neighbors = buildAdjacency(knownIds, pairs, true);

  const isolated: string[] = [];
  const connected: string[] = [];
  for (const node of sortIds(knownIds, byId)) {
    if ((neighbors.get(node)?.size ?? 0) === 0) isolated.push(node);
    else connected.push(node);
  }

  const components = findComponents(connected, byId, neighbors);
  const positions = new Map<string, LayoutPoint>();
  let top = 0;
  let width = 0;
  let componentWidth = 0;

  for (const component of components) {
    const layout = computeComponentLayout(
      component,
      pairs,
      byId,
      nodeWidth,
      nodeHeight,
      gapX,
      gapY,
    );
    for (const [id, point] of layout.positions) {
      positions.set(id, { x: point.x, y: Math.round(point.y + top) });
    }
    width = Math.max(width, layout.width);
    componentWidth = Math.max(componentWidth, layout.width);
    top += layout.height + 2 * gapY;
  }

  if (isolated.length > 0) {
    const columns =
      components.length === 0
        ? ISOLATED_COLUMNS_WITHOUT_COMPONENTS
        : Math.max(1, Math.floor(componentWidth / (nodeWidth + gapX)));
    const usedColumns = Math.max(1, Math.min(columns, isolated.length));

    isolated.forEach((id, index) => {
      const column = index % usedColumns;
      const row = Math.floor(index / usedColumns);
      positions.set(id, {
        x: Math.round(column * (nodeWidth + gapX)),
        y: Math.round(top + row * (nodeHeight + gapY)),
      });
    });
    width = Math.max(width, usedColumns * (nodeWidth + gapX) - gapX);
    const rows = Math.ceil(isolated.length / usedColumns);
    top += rows * nodeHeight + Math.max(0, rows - 1) * gapY;
  }

  return {
    positions,
    width: Math.round(width),
    height: Math.round(top),
  };
}
