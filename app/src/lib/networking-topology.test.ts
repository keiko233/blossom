import { describe, expect, it } from "vitest";

import {
  buildTopologyList,
  buildTopologyGraph,
  linkHealthTone,
  linkPhaseTone,
  linkEdgeStyle,
  matchedServerIds,
  moveTopologySelection,
  TOPOLOGY_EDGE_LEGEND,
  TOPOLOGY_LINK_HEALTH,
  TOPOLOGY_LINK_PHASES,
  topologySelectionOrder,
  visibleSelection,
  type EdgeDash,
  type EdgeTone,
  type TopologyInput,
  type TopologyLinkHealth,
  type TopologyLinkPhase,
} from "./networking-topology";

// Test-only fixture: A forwards to B's peer ingress, B forwards to C, and D
// is an isolated server. Not live data and not used outside this file.
const input: TopologyInput = {
  servers: [
    { id: "srv-c", name: "Gamma", enabled: true },
    { id: "srv-a", name: "Alpha", enabled: true },
    { id: "srv-d", name: "Delta", enabled: false },
    { id: "srv-b", name: "Beta", enabled: true },
  ],
  peerInbounds: [
    {
      id: "in-b",
      serverId: "srv-b",
      name: "Transit ingress",
      protocol: "trojan",
    },
    { id: "in-c", serverId: "srv-c", name: "Exit ingress", protocol: "vless" },
  ],
  links: [
    {
      id: "link-bc",
      sourceServerId: "srv-b",
      destinationInboundId: "in-c",
      phase: "stalled",
      health: "unknown",
    },
    {
      id: "link-ab",
      sourceServerId: "srv-a",
      destinationInboundId: "in-b",
      phase: "applied",
      health: "degraded",
    },
    {
      id: "link-orphan",
      sourceServerId: "srv-a",
      destinationInboundId: "in-missing",
      phase: "draft",
      health: "unknown",
    },
  ],
};

describe("buildTopologyList", () => {
  it("lists every server by name, including isolated ones", () => {
    const { servers } = buildTopologyList(input);

    expect(servers.map((s) => s.id)).toEqual([
      "srv-a",
      "srv-b",
      "srv-d",
      "srv-c",
    ]);
    expect(servers.find((s) => s.id === "srv-d")).toMatchObject({
      enabled: false,
      outgoing: [],
      incoming: [],
    });
  });

  it("places each link under its source and destination", () => {
    const { servers } = buildTopologyList(input);
    const beta = servers.find((s) => s.id === "srv-b");

    expect(beta?.incoming).toEqual([
      {
        id: "link-ab",
        direction: "incoming",
        peerServerId: "srv-a",
        peerServerName: "Alpha",
        inboundName: "Transit ingress",
        protocol: "trojan",
        phase: "applied",
        health: "degraded",
      },
    ]);
    expect(beta?.outgoing.map((l) => [l.id, l.peerServerName])).toEqual([
      ["link-bc", "Gamma"],
    ]);
  });

  it("reports links with missing endpoints instead of rendering them", () => {
    const { servers, unresolvedLinkIds } = buildTopologyList(input);

    expect(unresolvedLinkIds).toEqual(["link-orphan"]);
    expect(servers.flatMap((s) => s.outgoing).map((l) => l.id)).not.toContain(
      "link-orphan",
    );
  });

  it("keeps a matching server whole and filters other servers' links", () => {
    const { servers } = buildTopologyList(input, "  gamma ");

    expect(servers.map((s) => s.id)).toEqual(["srv-b", "srv-c"]);
    expect(servers[0].incoming).toEqual([]);
    expect(servers[0].outgoing.map((l) => l.id)).toEqual(["link-bc"]);
    expect(servers[1].incoming.map((l) => l.id)).toEqual(["link-bc"]);
  });

  it("matches inbound names on both ends of a link", () => {
    const { servers } = buildTopologyList(input, "transit");

    expect(servers.map((s) => s.id)).toEqual(["srv-a", "srv-b"]);
  });
});

describe("selection", () => {
  const { servers } = buildTopologyList(input);

  it("orders servers followed by their outgoing links", () => {
    expect(topologySelectionOrder(servers)).toEqual([
      { kind: "server", id: "srv-a" },
      { kind: "link", id: "link-ab" },
      { kind: "server", id: "srv-b" },
      { kind: "link", id: "link-bc" },
      { kind: "server", id: "srv-d" },
      { kind: "server", id: "srv-c" },
    ]);
  });

  it("moves and clamps across the list", () => {
    expect(moveTopologySelection(servers, null, "next")).toEqual({
      kind: "server",
      id: "srv-a",
    });
    expect(
      moveTopologySelection(servers, { kind: "link", id: "link-ab" }, "next"),
    ).toEqual({ kind: "server", id: "srv-b" });
    expect(
      moveTopologySelection(
        servers,
        { kind: "server", id: "srv-a" },
        "previous",
      ),
    ).toEqual({ kind: "server", id: "srv-a" });
    expect(moveTopologySelection(servers, null, "last")).toEqual({
      kind: "server",
      id: "srv-c",
    });
    expect(moveTopologySelection([], null, "first")).toBeNull();
  });

  it("clears a selection hidden by search", () => {
    const filtered = buildTopologyList(input, "gamma").servers;

    expect(
      visibleSelection(filtered, { kind: "link", id: "link-ab" }),
    ).toBeNull();
    expect(visibleSelection(filtered, { kind: "link", id: "link-bc" })).toEqual(
      {
        kind: "link",
        id: "link-bc",
      },
    );
  });
});

describe("tones", () => {
  it("keeps rollout phase and peer health independent", () => {
    expect(linkPhaseTone("applied")).toBe("success");
    expect(linkHealthTone("degraded")).toBe("warning");
    expect(linkPhaseTone("failed")).toBe("error");
    expect(linkHealthTone("unknown")).toBe("outline");
  });
});

const EXPECTED_EDGE_STYLES: Record<
  TopologyLinkPhase,
  Record<TopologyLinkHealth, [EdgeTone, EdgeDash, number, boolean]>
> = {
  failed: {
    unknown: ["danger", "solid", 2, false],
    healthy: ["danger", "solid", 2, false],
    degraded: ["danger", "solid", 2, false],
  },
  stalled: {
    unknown: ["warning", "dashed", 1.5, false],
    healthy: ["warning", "dashed", 1.5, false],
    degraded: ["warning", "dashed", 1.5, false],
  },
  applied: {
    unknown: ["muted", "solid", 1.5, false],
    healthy: ["success", "solid", 1.5, false],
    degraded: ["warning", "solid", 2, false],
  },
  pending: {
    unknown: ["info", "dashed", 1.5, false],
    healthy: ["info", "dashed", 1.5, false],
    degraded: ["info", "dashed", 1.5, false],
  },
  applying: {
    unknown: ["info", "dashed", 1.5, true],
    healthy: ["info", "dashed", 1.5, true],
    degraded: ["info", "dashed", 1.5, true],
  },
  removing: {
    unknown: ["muted", "dashed", 1.5, true],
    healthy: ["muted", "dashed", 1.5, true],
    degraded: ["muted", "dashed", 1.5, true],
  },
  draft: {
    unknown: ["muted", "dotted", 1.5, false],
    healthy: ["muted", "dotted", 1.5, false],
    degraded: ["muted", "dotted", 1.5, false],
  },
};

describe("linkEdgeStyle", () => {
  it("matches the style table for every phase and health pair", () => {
    for (const phase of TOPOLOGY_LINK_PHASES) {
      for (const health of TOPOLOGY_LINK_HEALTH) {
        const style = linkEdgeStyle(phase, health);
        expect([style.tone, style.dash, style.width, style.animated]).toEqual(
          EXPECTED_EDGE_STYLES[phase][health],
        );
      }
    }
  });

  it("animates only in-flight work", () => {
    const animated = TOPOLOGY_LINK_PHASES.filter((phase) =>
      TOPOLOGY_LINK_HEALTH.some(
        (health) => linkEdgeStyle(phase, health).animated,
      ),
    );

    expect(animated).toEqual(["applying", "removing"]);
  });

  it("has a legend entry for every distinct style", () => {
    const distinct = new Set(
      TOPOLOGY_LINK_PHASES.flatMap((phase) =>
        TOPOLOGY_LINK_HEALTH.map((health) =>
          JSON.stringify(linkEdgeStyle(phase, health)),
        ),
      ),
    );
    const legend = TOPOLOGY_EDGE_LEGEND.map((entry) =>
      JSON.stringify(entry.style),
    );

    expect(new Set(legend).size).toBe(TOPOLOGY_EDGE_LEGEND.length);
    expect(new Set(legend)).toEqual(distinct);
    expect(TOPOLOGY_EDGE_LEGEND.every((entry) => entry.key.length > 0)).toBe(
      true,
    );
  });
});

describe("matchedServerIds", () => {
  const { servers } = buildTopologyList(input);
  const list = { servers, unresolvedLinkIds: [] };

  it("returns null for an empty query", () => {
    expect(matchedServerIds(list, "")).toBeNull();
    expect(matchedServerIds(list, "   ")).toBeNull();
  });

  it("matches a server by name", () => {
    expect([...(matchedServerIds(list, "delta") ?? [])]).toEqual(["srv-d"]);
  });

  it("lights both ends of a link whose inbound matches", () => {
    const matched = matchedServerIds(
      {
        servers: list.servers,
        unresolvedLinkIds: [],
      },
      "transit",
    );

    expect([...(matched ?? [])].sort()).toEqual(["srv-a", "srv-b"]);
  });
});

describe("buildTopologyGraph", () => {
  const list = buildTopologyList(input);
  const graph = buildTopologyGraph(input, list, null, null);

  it("emits a node per server and an edge per resolved link", () => {
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "srv-a",
      "srv-b",
      "srv-d",
      "srv-c",
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["link-ab", "link-bc"]);
  });

  it("omits unresolved links", () => {
    expect(graph.edges.map((edge) => edge.id)).not.toContain("link-orphan");
  });

  it("counts incoming and outgoing links per node", () => {
    const beta = graph.nodes.find((node) => node.id === "srv-b");

    expect(beta?.data).toMatchObject({ incoming: 1, outgoing: 1 });
    expect(graph.nodes.find((node) => node.id === "srv-d")?.data).toMatchObject(
      { incoming: 0, outgoing: 0 },
    );
  });

  it("maps runtime and config state to a node tone", () => {
    const runtime = new Map([
      ["srv-a", { runtimeState: "crash_loop", configState: "applied" }],
      ["srv-b", { runtimeState: "running", configState: "rejected" }],
      ["srv-c", { runtimeState: "running", configState: "unknown" }],
    ]);
    const toned = buildTopologyGraph(input, list, null, null, runtime);
    const tone = (id: string) =>
      toned.nodes.find((node) => node.id === id)?.data.tone;

    expect(tone("srv-a")).toBe("danger");
    expect(tone("srv-b")).toBe("danger");
    expect(tone("srv-c")).toBe("warning");
    expect(tone("srv-d")).toBe("muted");
  });

  it("defaults a healthy linked server to success", () => {
    const runtime = new Map([
      ["srv-a", { runtimeState: "running", configState: "applied" }],
    ]);
    const toned = buildTopologyGraph(input, list, null, null, runtime);

    expect(toned.nodes.find((node) => node.id === "srv-a")?.data.tone).toBe(
      "success",
    );
  });

  it("flags the selected server and link", () => {
    const serverSelected = buildTopologyGraph(
      input,
      list,
      { kind: "server", id: "srv-b" },
      null,
    );
    expect(
      serverSelected.nodes
        .filter((node) => node.data.selected)
        .map((n) => n.id),
    ).toEqual(["srv-b"]);

    const linkSelected = buildTopologyGraph(
      input,
      list,
      { kind: "link", id: "link-ab" },
      null,
    );
    expect(
      linkSelected.edges.filter((edge) => edge.data.selected).map((e) => e.id),
    ).toEqual(["link-ab"]);
  });

  it("dims unmatched nodes and edges only when a query is active", () => {
    const matched = matchedServerIds(
      { servers: list.servers, unresolvedLinkIds: [] },
      "delta",
    );
    const dimmed = buildTopologyGraph(input, list, null, matched);
    const dimmedNodes = dimmed.nodes
      .filter((node) => node.data.dimmed)
      .map((node) => node.id);

    expect(dimmedNodes).toEqual(["srv-a", "srv-b", "srv-c"]);
    expect(
      dimmed.edges.filter((edge) => edge.data.dimmed).map((edge) => edge.id),
    ).toEqual(["link-ab", "link-bc"]);
    expect(
      buildTopologyGraph(input, list, null, matched).nodes.find(
        (node) => node.id === "srv-d",
      )?.data.dimmed,
    ).toBe(false);
    expect(graph.nodes.some((node) => node.data.dimmed)).toBe(false);
  });

  it("numbers parallel links between the same ordered pair", () => {
    const parallel: TopologyInput = {
      servers: [
        { id: "a", name: "Alpha", enabled: true },
        { id: "b", name: "Beta", enabled: true },
      ],
      peerInbounds: [
        { id: "in-1", serverId: "b", name: "First", protocol: "vless" },
        { id: "in-2", serverId: "b", name: "Second", protocol: "trojan" },
      ],
      links: [
        {
          id: "l-1",
          sourceServerId: "a",
          destinationInboundId: "in-1",
          phase: "applied",
          health: "healthy",
        },
        {
          id: "l-2",
          sourceServerId: "a",
          destinationInboundId: "in-2",
          phase: "pending",
          health: "unknown",
        },
      ],
    };
    const parallelList = buildTopologyList(parallel);
    const parallelGraph = buildTopologyGraph(
      parallel,
      parallelList,
      null,
      null,
    );

    expect(
      parallelGraph.edges.map((edge) => [
        edge.id,
        edge.data.parallelIndex,
        edge.data.parallelCount,
      ]),
    ).toEqual([
      ["l-1", 0, 2],
      ["l-2", 1, 2],
    ]);
  });

  it("carries the resolved endpoint names for the edge label", () => {
    const edge = graph.edges.find((candidate) => candidate.id === "link-ab");

    expect(edge?.data).toMatchObject({
      sourceServerName: "Alpha",
      destinationServerName: "Beta",
      destinationInboundName: "Transit ingress",
      protocol: "trojan",
    });
    expect(edge?.source).toBe("srv-a");
    expect(edge?.target).toBe("srv-b");
  });
});
