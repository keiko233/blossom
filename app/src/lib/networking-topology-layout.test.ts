import { describe, expect, it } from "vitest";

import {
  layoutLayered,
  type LayoutEdge,
  type LayoutNode,
  type LayoutPoint,
  type LayoutResult,
} from "./networking-topology-layout";

const OPTIONS = { nodeWidth: 100, nodeHeight: 40, gapX: 20, gapY: 10 };

function node(id: string, name = id): LayoutNode {
  return { id, name };
}

function edge(source: string, target: string): LayoutEdge {
  return { id: `${source}->${target}`, source, target };
}

function position(result: LayoutResult, id: string): LayoutPoint {
  const point = result.positions.get(id);
  if (!point) throw new Error(`missing position for ${id}`);
  return point;
}

/** Deterministic PRNG (mulberry32) so the shuffle tests are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function snapshot(result: LayoutResult): Record<string, LayoutPoint> {
  return Object.fromEntries(
    [...result.positions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, point]) => [id, point]),
  );
}

function overlaps(a: LayoutPoint, b: LayoutPoint): boolean {
  return (
    a.x < b.x + OPTIONS.nodeWidth &&
    b.x < a.x + OPTIONS.nodeWidth &&
    a.y < b.y + OPTIONS.nodeHeight &&
    b.y < a.y + OPTIONS.nodeHeight
  );
}

describe("layoutLayered", () => {
  it("returns nothing for an empty graph", () => {
    const result = layoutLayered([], [], OPTIONS);

    expect(result.positions.size).toBe(0);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it("places a single node at the origin", () => {
    const result = layoutLayered([node("a")], [], OPTIONS);

    expect(position(result, "a")).toEqual({ x: 0, y: 0 });
    expect(result.width).toBe(OPTIONS.nodeWidth);
    expect(result.height).toBe(OPTIONS.nodeHeight);
  });

  it("lays a chain out left to right in three layers", () => {
    const result = layoutLayered(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c")],
      OPTIONS,
    );
    const a = position(result, "a");
    const b = position(result, "b");
    const c = position(result, "c");

    expect(a.x).toBe(0);
    expect(b.x).toBe(OPTIONS.nodeWidth + OPTIONS.gapX);
    expect(c.x).toBe(2 * (OPTIONS.nodeWidth + OPTIONS.gapX));
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
  });

  it("splits a diamond into three layers and centers the middle", () => {
    const result = layoutLayered(
      [node("a"), node("b"), node("c"), node("d")],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
      OPTIONS,
    );
    const a = position(result, "a");
    const b = position(result, "b");
    const c = position(result, "c");
    const d = position(result, "d");

    expect(new Set([a.x, b.x, d.x]).size).toBe(3);
    expect(b.x).toBe(c.x);
    expect(b.y).not.toBe(c.y);
    expect(a.y).toBeGreaterThan(Math.min(b.y, c.y));
    expect(a.y).toBeLessThan(Math.max(b.y, c.y));
    expect(d.y).toBe(a.y);
  });

  it("terminates on a two-node cycle and separates the layers", () => {
    const result = layoutLayered(
      [node("a"), node("b")],
      [edge("a", "b"), edge("b", "a")],
      OPTIONS,
    );

    expect(result.positions.size).toBe(2);
    expect(position(result, "a").x).not.toBe(position(result, "b").x);
  });

  it("ignores self-loops and edges with unknown endpoints", () => {
    const base = layoutLayered(
      [node("a"), node("b"), node("c")],
      [edge("a", "b")],
      OPTIONS,
    );
    const withNoise = layoutLayered(
      [node("a"), node("b"), node("c")],
      [
        edge("a", "b"),
        edge("a", "a"),
        edge("a", "missing"),
        { id: "ghost", source: "ghost", target: "b" },
      ],
      OPTIONS,
    );

    expect(position(withNoise, "b")).toEqual(position(base, "b"));
    expect(withNoise.positions).not.toHaveProperty("missing");
  });

  it("collapses parallel edges so they do not change positions", () => {
    const single = layoutLayered(
      [node("a"), node("b")],
      [edge("a", "b")],
      OPTIONS,
    );
    const parallel = layoutLayered(
      [node("a"), node("b")],
      [
        edge("a", "b"),
        { id: "a->b#2", source: "a", target: "b" },
        { id: "a->b#3", source: "a", target: "b" },
      ],
      OPTIONS,
    );

    expect(snapshot(parallel)).toEqual(snapshot(single));
  });

  it("is deterministic under ten seeded shuffles", () => {
    const nodes = [
      node("s1", "Alpha"),
      node("s2", "Beta"),
      node("s3", "Gamma"),
      node("s4", "Delta"),
      node("s5", "Epsilon"),
    ];
    const edges = [
      edge("s1", "s2"),
      edge("s1", "s3"),
      edge("s2", "s4"),
      edge("s3", "s4"),
      edge("s4", "s5"),
      edge("s5", "s1"),
    ];
    const expected = snapshot(layoutLayered(nodes, edges, OPTIONS));

    for (let seed = 1; seed <= 10; seed += 1) {
      const random = seededRandom(seed);
      const result = layoutLayered(
        shuffle(nodes, random),
        shuffle(edges, random),
        OPTIONS,
      );
      expect(snapshot(result)).toEqual(expected);
    }
  });

  it("puts isolated nodes in a grid below the connected components", () => {
    const result = layoutLayered(
      [node("a"), node("b"), node("c"), node("i1"), node("i2"), node("i3")],
      [edge("a", "b"), edge("b", "c")],
      OPTIONS,
    );
    const a = position(result, "a");
    const c = position(result, "c");
    const isolated = ["i1", "i2", "i3"].map((id) => position(result, id));

    for (const point of isolated) {
      expect(point.y).toBeGreaterThan(Math.max(a.y, c.y));
    }
    expect(new Set(isolated.map((point) => point.x)).size).toBeGreaterThan(1);
  });

  it("never overlaps 60 seeded random nodes", () => {
    const random = seededRandom(20261126);
    const nodes = Array.from({ length: 60 }, (_, index) =>
      node(`n${index}`, `Node ${String(index).padStart(2, "0")}`),
    );
    const edges: LayoutEdge[] = [];
    for (let index = 1; index < nodes.length; index += 1) {
      const source = Math.floor(random() * index);
      edges.push(edge(nodes[source].id, nodes[index].id));
      if (random() < 0.3) {
        const extra = Math.floor(random() * index);
        edges.push(edge(nodes[extra].id, nodes[index].id));
      }
    }

    const result = layoutLayered(nodes, edges, OPTIONS);
    const points = [...result.positions.values()];

    expect(points).toHaveLength(nodes.length);
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        expect(overlaps(points[left], points[right])).toBe(false);
      }
    }
  });

  it("lays out 200 nodes in under 100 ms", () => {
    const nodes = Array.from({ length: 200 }, (_, index) =>
      node(`n${index}`, `Node ${index}`),
    );
    const edges = nodes
      .slice(1)
      .map((target, index) => edge(nodes[index % 7].id, target.id));
    const random = seededRandom(7);
    const shuffledNodes = shuffle(nodes, random);
    const shuffledEdges = shuffle(edges, random);

    const startedAt = performance.now();
    const result = layoutLayered(shuffledNodes, shuffledEdges, OPTIONS);
    const elapsed = performance.now() - startedAt;

    expect(result.positions.size).toBe(200);
    if (!process.env.CI_SLOW) expect(elapsed).toBeLessThan(100);
  });

  it("does not move existing nodes when an isolated node is added", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b"), edge("b", "c")];
    const before = layoutLayered(nodes, edges, OPTIONS);
    const after = layoutLayered([...nodes, node("z")], edges, OPTIONS);

    for (const id of ["a", "b", "c"]) {
      expect(position(after, id)).toEqual(position(before, id));
    }
  });
});
