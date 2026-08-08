import { describe, expect, it } from "vitest";

import type { Node } from "@/db/proxy-schema";
import type { ResolvedNode } from "@/query/subscription-access";

import {
  applyPublishGate,
  type GateInput,
  type NodeChangePrevRow,
  type PendingConfigChange,
} from "./publish-gate";

const NOW = new Date("2026-08-09T00:00:00Z");
const FUTURE = new Date("2026-09-01T00:00:00Z");
const PAST = new Date("2026-08-01T00:00:00Z");

function makeNode(id: string, serverId: string, listenPort = 443): Node {
  return {
    id,
    name: `Node ${id}`,
    remark: null,
    tags: [],
    enabled: true,
    serverId,
    address: null,
    listenPort,
    protocol: "vless",
    certificateId: null,
    tlsServerName: null,
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
}

function makeResolved(node: Node): ResolvedNode {
  return {
    node,
    server: {
      id: node.serverId,
      name: `Server ${node.serverId}`,
      address: "example.com",
    },
    address: "example.com",
    certificateKind: null,
  };
}

function makeSubscription(overrides: Partial<GateInput["subscription"]> = {}) {
  return {
    id: "sub-1",
    userId: "user-1",
    planId: "plan-1",
    status: "active" as const,
    expiresAt: FUTURE,
    credentialUuid: "uuid-new",
    credentialPassword: "password-new",
    ...overrides,
  };
}

function makeInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    now: NOW,
    subscription: makeSubscription(),
    user: { banned: null, banExpires: null },
    nodes: [],
    pending: [],
    planGroupIds: new Map([["plan-1", ["group-1"]]]),
    groupNodeIds: new Map(),
    ...overrides,
  };
}

function pending(
  change: Partial<PendingConfigChange> &
    Pick<PendingConfigChange, "kind" | "subjectId" | "serverId">,
): PendingConfigChange {
  return { prevRow: null, revisionSeq: 1, ...change };
}

describe("applyPublishGate", () => {
  it("passes everything through when nothing is pending", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(makeInput({ nodes: [node] }));
    expect(result.eligible).toBe(true);
    expect(result.nodes).toEqual([node]);
    expect(result.credentialsByNodeId.size).toBe(0);
  });

  it("replays the previous node snapshot while a node update is unapplied", () => {
    const before = makeNode("n1", "srv-a", 8000);
    const after = makeNode("n1", "srv-a", 8001);
    const prevRow: NodeChangePrevRow = {
      node: before,
      server: { id: "srv-a", name: "Server srv-a", address: "example.com" },
      certificateKind: null,
    };
    const result = applyPublishGate(
      makeInput({
        nodes: [makeResolved(after)],
        pending: [
          pending({
            kind: "node",
            subjectId: "n1",
            serverId: "srv-a",
            prevRow,
          }),
        ],
      }),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.node.listenPort).toBe(8000);
  });

  it("replays to the oldest unapplied snapshot when several changes queue up", () => {
    const oldest = makeNode("n1", "srv-a", 8000);
    const middle = makeNode("n1", "srv-a", 8001);
    const current = makeNode("n1", "srv-a", 8002);
    const snapshotOf = (node: Node): NodeChangePrevRow => ({
      node,
      server: { id: "srv-a", name: "Server srv-a", address: "example.com" },
      certificateKind: null,
    });
    const result = applyPublishGate(
      makeInput({
        nodes: [makeResolved(current)],
        pending: [
          pending({
            kind: "node",
            subjectId: "n1",
            serverId: "srv-a",
            revisionSeq: 3,
            prevRow: snapshotOf(middle),
          }),
          pending({
            kind: "node",
            subjectId: "n1",
            serverId: "srv-a",
            revisionSeq: 2,
            prevRow: snapshotOf(oldest),
          }),
        ],
      }),
    );
    expect(result.nodes[0]!.node.listenPort).toBe(8000);
  });

  it("does not replay a node whose change is pending on a different server", () => {
    const node = makeResolved(makeNode("n1", "srv-b", 8001));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        pending: [
          pending({
            kind: "node",
            subjectId: "n1",
            serverId: "srv-a",
            prevRow: {
              node: makeNode("n1", "srv-b", 8000),
              server: {
                id: "srv-b",
                name: "Server srv-b",
                address: "example.com",
              },
              certificateKind: null,
            } satisfies NodeChangePrevRow,
          }),
        ],
      }),
    );
    expect(result.nodes[0]!.node.listenPort).toBe(8001);
  });

  it("withholds a newly created node until the agent applies it", () => {
    const result = applyPublishGate(
      makeInput({
        nodes: [makeResolved(makeNode("n1", "srv-a"))],
        pending: [
          pending({ kind: "node", subjectId: "n1", serverId: "srv-a" }),
        ],
      }),
    );
    expect(result.nodes).toHaveLength(0);
  });

  it("withholds a node whose enable transition is still unapplied", () => {
    const before = { ...makeNode("n1", "srv-a"), enabled: false };
    const prevRow: NodeChangePrevRow = {
      node: before,
      server: { id: "srv-a", name: "Server srv-a", address: "example.com" },
      certificateKind: null,
    };
    const result = applyPublishGate(
      makeInput({
        nodes: [makeResolved(makeNode("n1", "srv-a"))],
        pending: [
          pending({
            kind: "node",
            subjectId: "n1",
            serverId: "srv-a",
            prevRow,
          }),
        ],
      }),
    );
    expect(result.nodes).toHaveLength(0);
  });

  it("falls back to previous credentials per unapplied server", () => {
    const nodeA = makeResolved(makeNode("n1", "srv-a"));
    const nodeB = makeResolved(makeNode("n2", "srv-b"));
    const result = applyPublishGate(
      makeInput({
        nodes: [nodeA, nodeB],
        pending: [
          pending({
            kind: "credential",
            subjectId: "sub-1",
            serverId: "srv-a",
            prevRow: {
              credentialUuid: "uuid-old",
              credentialPassword: "password-old",
            },
          }),
        ],
      }),
    );
    expect(result.credentialsByNodeId.get("n1")).toEqual({
      uuid: "uuid-old",
      password: "password-old",
    });
    expect(result.credentialsByNodeId.has("n2")).toBe(false);
  });

  it("withholds nodes on servers where the subscription creation is unapplied", () => {
    const nodeA = makeResolved(makeNode("n1", "srv-a"));
    const nodeB = makeResolved(makeNode("n2", "srv-b"));
    const result = applyPublishGate(
      makeInput({
        nodes: [nodeA, nodeB],
        pending: [
          // prevRow null: the subscription (and its credentials) did not exist
          // in the applied state of srv-a.
          pending({
            kind: "credential",
            subjectId: "sub-1",
            serverId: "srv-a",
          }),
        ],
      }),
    );
    expect(result.nodes.map((resolved) => resolved.node.id)).toEqual(["n2"]);
  });

  it("withholds nodes newly granted via a group membership change", () => {
    const kept = makeResolved(makeNode("n1", "srv-a"));
    const added = makeResolved(makeNode("n2", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [kept, added],
        groupNodeIds: new Map([["group-1", ["n1", "n2"]]]),
        pending: [
          pending({
            kind: "authorization",
            subjectId: "group-1",
            serverId: "srv-a",
            prevRow: { nodeIds: ["n1"] },
          }),
        ],
      }),
    );
    expect(result.nodes.map((resolved) => resolved.node.id)).toEqual(["n1"]);
  });

  it("replays visibility against the previous plan after a plan switch", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        // Current plan-2 sees the node; previous plan-1 did not.
        subscription: makeSubscription({ planId: "plan-2" }),
        planGroupIds: new Map([
          ["plan-1", ["group-old"]],
          ["plan-2", ["group-1"]],
        ]),
        groupNodeIds: new Map([
          ["group-1", ["n1"]],
          ["group-old", []],
        ]),
        pending: [
          pending({
            kind: "authorization",
            subjectId: "sub-1",
            serverId: "srv-a",
            prevRow: {
              planId: "plan-1",
              status: "active",
              expiresAt: FUTURE.toISOString(),
            },
          }),
        ],
      }),
    );
    expect(result.nodes).toHaveLength(0);
  });

  it("marks a re-activated subscription ineligible until agents apply", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        pending: [
          pending({
            kind: "authorization",
            subjectId: "sub-1",
            serverId: "srv-a",
            prevRow: {
              planId: "plan-1",
              status: "cancelled",
              expiresAt: FUTURE.toISOString(),
            },
          }),
        ],
      }),
    );
    expect(result.eligible).toBe(false);
  });

  it("marks an expired-then-extended subscription ineligible until applied", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        pending: [
          pending({
            kind: "authorization",
            subjectId: "sub-1",
            serverId: "srv-a",
            prevRow: {
              planId: "plan-1",
              status: "active",
              expiresAt: PAST.toISOString(),
            },
          }),
        ],
      }),
    );
    expect(result.eligible).toBe(false);
  });

  it("marks an unbanned user ineligible until agents apply the unban", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        pending: [
          pending({
            kind: "authorization",
            subjectId: "user-1",
            serverId: "srv-a",
            prevRow: { banned: true, banExpires: null },
          }),
        ],
      }),
    );
    expect(result.eligible).toBe(false);
  });

  it("does not gate a ban (the safe direction)", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        user: { banned: true, banExpires: null },
        pending: [
          pending({
            kind: "authorization",
            subjectId: "user-1",
            serverId: "srv-a",
            prevRow: { banned: null, banExpires: null },
          }),
        ],
      }),
    );
    // The route's own eligibility check already refuses banned users; the
    // gate must not resurrect access here.
    expect(result.eligible).toBe(true);
  });

  it("hides nodes on a server whose enable transition is unapplied", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        pending: [
          pending({
            kind: "server",
            subjectId: "srv-a",
            serverId: "srv-a",
            prevRow: { enabled: false },
          }),
        ],
      }),
    );
    expect(result.nodes).toHaveLength(0);
  });

  it("ignores certificate changes (no client-facing difference)", () => {
    const node = makeResolved(makeNode("n1", "srv-a"));
    const result = applyPublishGate(
      makeInput({
        nodes: [node],
        pending: [
          pending({
            kind: "certificate",
            subjectId: "cert-1",
            serverId: "srv-a",
            prevRow: { desiredGeneration: 1 },
          }),
        ],
      }),
    );
    expect(result.nodes).toEqual([node]);
  });
});
