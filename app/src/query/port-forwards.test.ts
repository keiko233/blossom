import { describe, expect, it } from "vitest";

import type { Node } from "@/db/proxy-schema";
import { applyPortForwardOverlay } from "@/lib/port-forward-relay";
import {
  deletePortForwardSchema,
  savePortForwardSchema,
} from "@/lib/port-forward-schema";
import type { ResolvedNode } from "@/query/subscription-access";

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "node-exit",
    name: "Exit Node",
    remark: null,
    tags: [],
    enabled: true,
    serverId: "server-exit",
    address: null,
    listenPort: 443,
    protocol: "vless",
    certificateId: null,
    tlsServerName: "exit.example",
    settings: {
      tls: { enabled: true, server_name: "exit.example" },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Node;
}

function makeResolved(node: Node = makeNode()): ResolvedNode {
  return {
    node,
    server: {
      id: node.serverId,
      name: "Exit Server",
      address: "exit.example",
      enabled: true,
    },
    address: node.address ?? "exit.example",
    certificateKind: null,
  };
}

describe("savePortForwardSchema", () => {
  const base = {
    serverId: "server-transit",
    expectedTopologyGeneration: 4,
    name: "HK relay",
    listenPort: 8443,
  };

  it("defaults the listen address, network and enabled flag", () => {
    const parsed = savePortForwardSchema.parse({
      ...base,
      targetNodeId: "node-exit",
    });
    expect(parsed).toMatchObject({
      listenAddress: "::",
      network: "both",
      enabled: true,
      targetNodeId: "node-exit",
    });
  });

  it("accepts an external host and port target", () => {
    const parsed = savePortForwardSchema.parse({
      ...base,
      targetAddress: "203.0.113.10",
      targetPort: 443,
    });
    expect(parsed.targetAddress).toBe("203.0.113.10");
    expect(parsed.targetPort).toBe(443);
    expect(parsed.targetNodeId).toBeUndefined();
  });

  it("rejects a managed node mixed with an external target", () => {
    const result = savePortForwardSchema.safeParse({
      ...base,
      targetNodeId: "node-exit",
      targetAddress: "203.0.113.10",
      targetPort: 443,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing target", () => {
    const result = savePortForwardSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("rejects an external target without both fields", () => {
    const result = savePortForwardSchema.safeParse({
      ...base,
      targetAddress: "203.0.113.10",
    });
    expect(result.success).toBe(false);
  });

  it("bounds the listen and target ports", () => {
    expect(
      savePortForwardSchema.safeParse({ ...base, listenPort: 0 }).success,
    ).toBe(false);
    expect(
      savePortForwardSchema.safeParse({ ...base, listenPort: 65_536 }).success,
    ).toBe(false);
  });
});

describe("deletePortForwardSchema", () => {
  it("requires the id and expected topology generation", () => {
    expect(
      deletePortForwardSchema.safeParse({
        id: "forward-1",
        expectedTopologyGeneration: 3,
      }).success,
    ).toBe(true);
    expect(deletePortForwardSchema.safeParse({ id: "forward-1" }).success).toBe(
      false,
    );
  });
});

describe("applyPortForwardOverlay", () => {
  const forward = {
    id: "forward-1",
    runtimeTag: "relay-in-forward-1",
    name: "Transit relay",
    listenPort: 8443,
    targetNodeId: "node-exit",
    enabled: true,
  };

  it("keeps exit-node protocol settings but swaps the endpoint and port", () => {
    const exit = makeResolved();
    const transit = {
      id: "server-transit",
      name: "Transit Server",
      address: "transit.example",
      enabled: true,
    };

    const relayed = applyPortForwardOverlay(exit, forward, transit);

    expect(relayed.address).toBe("transit.example");
    expect(relayed.portOverride).toBe(8443);
    expect(relayed.nameOverride).toBe("Transit relay");
    expect(relayed.server.id).toBe("server-transit");
    expect(relayed.node.id).toBe(exit.node.id);
    expect(relayed.node.name).toBe("Transit relay");
    expect(relayed.node.listenPort).toBe(8443);
    expect(relayed.node.protocol).toBe(exit.node.protocol);
    expect(relayed.node.settings).toBe(exit.node.settings);
    expect(relayed.portForward).toEqual({
      forwardId: "forward-1",
      runtimeTag: "relay-in-forward-1",
      targetNodeId: "node-exit",
      transitServerId: "server-transit",
      transitServerEnabled: true,
      exitServerEnabled: true,
    });
  });

  it("leaves the exit entrance untouched when the forward is disabled", () => {
    const exit = makeResolved();
    const relayed = applyPortForwardOverlay(
      exit,
      { ...forward, enabled: false },
      { id: "server-transit", name: "Transit", address: "transit.example" },
    );
    expect(relayed).toBe(exit);
  });

  it("leaves the entrance untouched when the forward targets another node", () => {
    const exit = makeResolved();
    const relayed = applyPortForwardOverlay(
      exit,
      { ...forward, targetNodeId: "node-other" },
      { id: "server-transit", name: "Transit", address: "transit.example" },
    );
    expect(relayed).toBe(exit);
  });
});
