import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import { describe, expect, it } from "vitest";

import {
  buildRoutingPreview,
  diffRoutingDrafts,
  MANAGED_RULE_SET_PRESET_CATALOG,
  outboundRouteReferences,
  planManagedRolloutStages,
} from "./networking-workspace";

function rule(
  partial: Partial<ManagedIntentRouteRule> & { ruleId: string },
): ManagedIntentRouteRule {
  return {
    ruleId: partial.ruleId,
    inboundTags: partial.inboundTags ?? ["node-a"],
    sniff: partial.sniff ?? false,
    resolveStrategy: partial.resolveStrategy ?? null,
    network: partial.network ?? null,
    domains: partial.domains ?? [],
    domainSuffixes: partial.domainSuffixes ?? [],
    domainKeywords: partial.domainKeywords ?? [],
    ipCidrs: partial.ipCidrs ?? [],
    ports: partial.ports ?? [],
    portRanges: partial.portRanges ?? [],
    protocols: partial.protocols ?? [],
    invert: partial.invert ?? false,
    ruleSetTags: partial.ruleSetTags ?? [],
    action: partial.action ?? "route",
    outboundTag: partial.outboundTag ?? "direct",
  };
}

const inbounds = [
  {
    tag: "node-a",
    name: "A ingress",
    protocol: "trojan",
    peer: false,
    enabled: true,
  },
  {
    tag: "peer-in-b",
    name: "B transit",
    protocol: "vless",
    peer: true,
    enabled: true,
  },
];
const outbounds = [
  {
    tag: "direct",
    name: "Direct",
    kind: "builtin_direct" as const,
    linkId: null,
    destinationServerId: null,
    destinationServerName: null,
    protocol: null,
    ipFamily: null,
  },
  {
    tag: "peer-out-ab",
    name: "To B",
    kind: "peer_link" as const,
    linkId: "ab",
    destinationServerId: "srv-b",
    destinationServerName: "Beta",
    protocol: "vless" as const,
    ipFamily: null,
  },
];
const tcpOnlyOutbound = {
  tag: "peer-out-tcp",
  name: "To TCP-only",
  kind: "peer_link" as const,
  linkId: "tcp",
  destinationServerId: "srv-tcp",
  destinationServerName: "TCP-only",
  protocol: "naive" as const,
  ipFamily: null,
};
const ruleSets = [
  {
    runtimeTag: "rule-set-geoip-cn",
    ruleSetId: "geoip-cn",
    version: "2026.11.20",
    format: "binary" as const,
    sizeBytes: 1024,
  },
];

describe("buildRoutingPreview", () => {
  it("emits ordered sniff, country route and explicit direct fallback", () => {
    const preview = buildRoutingPreview({
      rules: [
        rule({
          ruleId: "country",
          sniff: true,
          ipCidrs: ["1.0.1.0/24"],
          ruleSetTags: ["rule-set-geoip-cn"],
          outboundTag: "peer-out-ab",
        }),
        rule({
          ruleId: "remaining",
          outboundTag: "direct",
        }),
      ],
      finalOutboundTag: "direct",
      inbounds,
      outbounds,
      ruleSets,
    });

    expect(
      preview.actions.map((action) => [
        action.action,
        action.network,
        action.outboundTag,
        action.note,
      ]),
    ).toEqual([
      ["sniff", null, null, null],
      ["route", null, "peer-out-ab", null],
      ["route", null, "direct", null],
      ["reject", null, null, "peer_default_reject"],
      ["route", null, "direct", "final_fallback"],
    ]);
    expect(preview.issues).toEqual([]);
    expect(preview.peerOutboundTags).toEqual(["peer-out-ab"]);
    expect(preview.affectedInboundTags).toEqual(["node-a"]);
  });

  it("rejects a UDP peer route and warns about a shadowed later rule", () => {
    const preview = buildRoutingPreview({
      rules: [
        rule({
          ruleId: "catch-all",
          outboundTag: "peer-out-ab",
        }),
        rule({
          ruleId: "later",
          domains: ["example.test"],
          outboundTag: "direct",
        }),
        rule({
          ruleId: "udp-peer",
          network: "udp",
          outboundTag: "peer-out-tcp",
        }),
      ],
      finalOutboundTag: "direct",
      inbounds,
      outbounds: [...outbounds, tcpOnlyOutbound],
      ruleSets,
    });

    expect(preview.issues.map((issue) => issue.code).sort()).toEqual([
      "shadowed_rule",
      "udp_peer_route",
    ]);
  });

  it("marks unresolved inbounds, outbounds, rule sets and a peer fallback", () => {
    const preview = buildRoutingPreview({
      rules: [
        rule({
          ruleId: "missing",
          inboundTags: ["node-missing"],
          outboundTag: "peer-out-missing",
        }),
        rule({
          ruleId: "domain-ip",
          domains: ["example.test"],
          ipCidrs: ["10.0.0.0/8"],
          ruleSetTags: ["rule-set-missing"],
          outboundTag: "direct",
        }),
        rule({
          ruleId: "missing-outbound",
          outboundTag: "peer-out-missing",
        }),
      ],
      finalOutboundTag: "peer-out-ab",
      inbounds,
      outbounds,
      ruleSets,
    });

    expect(preview.issues.map((issue) => issue.code).sort()).toEqual(
      [
        "empty_rule_scope",
        "inbound_not_found",
        "outbound_not_found",
        "unknown_rule_set",
        "unresolved_destination_ip",
      ].sort(),
    );
  });

  it("allows UDP routes and a peer fallback when the outbound carries UDP", () => {
    const preview = buildRoutingPreview({
      rules: [
        rule({
          ruleId: "udp-peer",
          network: "udp",
          portRanges: ["1000-2000"],
          protocols: ["quic"],
          invert: true,
          outboundTag: "peer-out-ab",
        }),
        rule({
          ruleId: "tcp-only",
          network: "udp",
          outboundTag: "peer-out-tcp",
        }),
      ],
      finalOutboundTag: "peer-out-ab",
      inbounds,
      outbounds: [...outbounds, tcpOnlyOutbound],
      ruleSets,
    });

    expect(
      preview.actions.map((action) => [
        action.action,
        action.network,
        action.outboundTag,
        action.note,
      ]),
    ).toEqual([
      ["route", "udp", "peer-out-ab", null],
      ["reject", null, null, "peer_default_reject"],
      ["route", null, "peer-out-ab", "final_fallback"],
    ]);
    expect(preview.issues.map((issue) => issue.code)).toEqual([
      "udp_peer_route",
    ]);
    expect(preview.actions[0]?.match).toEqual({
      domains: [],
      domainSuffixes: [],
      domainKeywords: [],
      ipCidrs: [],
      ports: [],
      portRanges: ["1000-2000"],
      protocols: ["quic"],
      invert: true,
      ruleSetTags: [],
    });
  });

  it("rejects a TCP-only final outbound", () => {
    const preview = buildRoutingPreview({
      rules: [],
      finalOutboundTag: "peer-out-tcp",
      inbounds,
      outbounds: [...outbounds, tcpOnlyOutbound],
      ruleSets,
    });
    expect(preview.issues.map((issue) => issue.code)).toEqual([
      "final_outbound_is_peer",
    ]);
  });

  it("keeps a catch-all route to a TCP-only outbound TCP-only with a UDP reject", () => {
    const preview = buildRoutingPreview({
      rules: [
        rule({
          ruleId: "tcp-catch-all",
          outboundTag: "peer-out-tcp",
        }),
      ],
      finalOutboundTag: "direct",
      inbounds,
      outbounds: [...outbounds, tcpOnlyOutbound],
      ruleSets,
    });
    expect(
      preview.actions.map((action) => [
        action.action,
        action.network,
        action.outboundTag,
        action.note,
      ]),
    ).toEqual([
      ["route", "tcp", "peer-out-tcp", null],
      ["reject", "udp", null, "peer_udp_reject"],
      ["reject", null, null, "peer_default_reject"],
      ["route", null, "direct", "final_fallback"],
    ]);
  });
});

describe("diffRoutingDrafts", () => {
  const previous = {
    finalOutboundTag: "direct",
    rules: [
      rule({ ruleId: "one", domains: ["old.test"] }),
      rule({ ruleId: "two", ipCidrs: ["10.0.0.0/8"] }),
    ],
  };
  const next = {
    finalOutboundTag: "direct",
    rules: [
      rule({ ruleId: "two", ipCidrs: ["10.0.0.0/8"] }),
      rule({ ruleId: "one", domains: ["new.test"] }),
      rule({ ruleId: "three", outboundTag: "peer-out-ab" }),
    ],
  };

  it("reports added, changed, removed and reordered rules by id", () => {
    expect(diffRoutingDrafts(previous, next)).toMatchObject({
      addedRuleIds: ["three"],
      removedRuleIds: [],
      changedRuleIds: ["one"],
      reordered: true,
      finalOutboundChanged: false,
      peerOutboundTagsAdded: ["peer-out-ab"],
      affectedInboundTagsAdded: [],
    });
  });

  it("compares a first draft against an empty snapshot", () => {
    expect(diffRoutingDrafts(null, next)).toMatchObject({
      addedRuleIds: ["two", "one", "three"],
      removedRuleIds: [],
      changedRuleIds: [],
      reordered: false,
      finalOutboundChanged: false,
    });
  });
});

describe("planManagedRolloutStages", () => {
  const link = {
    id: "a-to-b",
    sourceServerId: "srv-a",
    destinationServerId: "srv-b",
  };

  it("stages the receiver before the sender", () => {
    const plan = planManagedRolloutStages({
      serverIds: ["srv-a", "srv-b"],
      links: [link],
      direction: "apply",
    });
    expect(plan.ok).toBe(true);
    expect(plan.stages.map((stage) => stage.serverId)).toEqual([
      "srv-b",
      "srv-a",
    ]);
    expect(plan.stages[0]).toMatchObject({
      ordinal: 1,
      roles: ["receiver"],
      dependsOnServerIds: [],
    });
    expect(plan.stages[1]).toMatchObject({
      ordinal: 2,
      roles: ["sender"],
      probeLinkIds: ["a-to-b"],
      dependsOnServerIds: ["srv-b"],
    });
  });

  it("stages the sender before the receiver on removal", () => {
    const plan = planManagedRolloutStages({
      serverIds: ["srv-a", "srv-b"],
      links: [link],
      direction: "remove",
    });
    expect(plan.stages.map((stage) => stage.serverId)).toEqual([
      "srv-a",
      "srv-b",
    ]);
    expect(plan.stages[0].roles).toEqual(["sender"]);
  });

  it("breaks ties by stable server id and reports cycles", () => {
    expect(
      planManagedRolloutStages({
        serverIds: ["srv-c", "srv-a", "srv-d"],
        links: [],
        direction: "apply",
      }).stages.map((stage) => stage.serverId),
    ).toEqual(["srv-a", "srv-c", "srv-d"]);

    const cycle = planManagedRolloutStages({
      serverIds: ["srv-a", "srv-b"],
      links: [
        link,
        {
          id: "b-to-a",
          sourceServerId: "srv-b",
          destinationServerId: "srv-a",
        },
      ],
      direction: "apply",
    });
    expect(cycle.ok).toBe(false);
    expect(cycle.stages).toEqual([]);
    expect(cycle.cycleServerIds).toEqual(["srv-a", "srv-b"]);
  });
});

describe("outboundRouteReferences", () => {
  it("lists dependent rules by outbound tag", () => {
    const refs = outboundRouteReferences([
      rule({ ruleId: "r1", outboundTag: "peer-out-ab" }),
      rule({ ruleId: "r2", outboundTag: "direct" }),
      rule({ ruleId: "r3", action: "reject", outboundTag: null }),
    ]);
    expect(refs.get("peer-out-ab")).toEqual([
      { ruleId: "r1", inboundTags: ["node-a"] },
    ]);
    expect(refs.get("direct")).toEqual([
      { ruleId: "r2", inboundTags: ["node-a"] },
    ]);
  });
});

describe("rule-set preset catalogue", () => {
  it("pins ids, versions and provenance without download URLs", () => {
    expect(MANAGED_RULE_SET_PRESET_CATALOG.length).toBeGreaterThan(0);
    for (const preset of MANAGED_RULE_SET_PRESET_CATALOG) {
      expect(preset.id).toMatch(/^[a-z0-9._-]+$/);
      expect(preset.suggestedVersion).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(preset.source).not.toMatch(/https?:|file:/);
    }
  });
});
