import { describe, expect, it } from "vitest";

import {
  buildTopologyList,
  linkHealthTone,
  linkPhaseTone,
  moveTopologySelection,
  topologySelectionOrder,
  visibleSelection,
  type TopologyInput,
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
