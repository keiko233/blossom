import { describe, expect, it } from "vitest";

import {
  autoBridgeSchema,
  saveCustomProxyOutboundSchema,
  saveOutboundGroupSchema,
  savePeerInboundSchema,
  type AutoBridgeInput,
} from "@/lib/networking-schema";

import {
  AUTO_BRIDGE_PORT_START,
  fullForwardRoutingRules,
  planAutoBridge,
  selectAutoBridgePort,
  type AutoBridgeInboundContext,
  type AutoBridgeNodeContext,
} from "./networking-auto-bridge";

function bridgeInput(partial: Partial<AutoBridgeInput> = {}): AutoBridgeInput {
  return {
    sourceServerId: "srv-transit",
    destinationServerId: "srv-exit",
    expectedTopologyGeneration: 0,
    protocol: "shadowsocks",
    mode: "auto_create_peer",
    fullForward: false,
    ...partial,
  };
}

const certificate = { id: "cert-exit", domains: ["exit.example.test"] };

const existingInbound: AutoBridgeInboundContext = {
  id: "inbound-exit",
  serverId: "srv-exit",
  runtimeTag: "peer-in-inbound-exit",
  protocol: "vless",
  listenPort: 20001,
  advertisedAddress: "exit.example.test",
  advertisedPort: 20001,
  network: "both",
  certificateId: "cert-exit",
  tlsServerName: "exit.example.test",
  settings: {},
};

const existingNode: AutoBridgeNodeContext = {
  id: "node-exit",
  serverId: "srv-exit",
  address: "exit.example.test",
  protocol: "trojan",
  certificateId: "cert-exit",
  tlsServerName: "exit.example.test",
  settings: { tls: { enabled: true, server_name: "raw.example.test" } },
};

describe("selectAutoBridgePort", () => {
  it("starts at the default or preferred port and skips taken listeners", () => {
    expect(selectAutoBridgePort(AUTO_BRIDGE_PORT_START, [])).toBe(
      AUTO_BRIDGE_PORT_START,
    );
    expect(selectAutoBridgePort(20_000, [20_000, 20_001, 20_003])).toBe(20_002);
    expect(selectAutoBridgePort(30_000, [29_999])).toBe(30_000);
  });

  it("returns null when nothing is free up to 65535", () => {
    expect(selectAutoBridgePort(65_533, [65_533, 65_534, 65_535])).toBeNull();
  });
});

describe("planAutoBridge", () => {
  it("applies protocol defaults for a new Shadowsocks peer", () => {
    const plan = planAutoBridge(bridgeInput(), {
      destinationAddress: "exit.example.test",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode === "reuse_peer_inbound") return;
    expect(plan).toMatchObject({
      protocol: "shadowsocks",
      network: "both",
      certificateId: null,
      tlsServerName: null,
      sourceNodeId: null,
      advertisedAddress: "exit.example.test",
      settings: { method: "2022-blake3-aes-128-gcm" },
    });
  });

  it("binds an active destination certificate for a TLS-only protocol", () => {
    const plan = planAutoBridge(
      bridgeInput({ protocol: "trojan", mode: "auto_create_peer" }),
      { destinationAddress: "exit.example.test", certificate },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode === "reuse_peer_inbound") return;
    expect(plan.certificateId).toBe("cert-exit");
    expect(plan.tlsServerName).toBe("exit.example.test");
  });

  it("fails closed when a required TLS certificate is unavailable", () => {
    const plan = planAutoBridge(
      bridgeInput({ protocol: "trojan", mode: "auto_create_peer" }),
      { destinationAddress: "exit.example.test" },
    );
    expect(plan).toMatchObject({ ok: false, reason: "certificate_not_found" });
  });

  it("allows Reality without managed X.509 material", () => {
    const plan = planAutoBridge(
      bridgeInput({
        protocol: "vless",
        settings: { tls: { enabled: true, reality: { enabled: true } } },
      }),
      { destinationAddress: "exit.example.test" },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode === "reuse_peer_inbound") return;
    expect(plan.certificateId).toBeNull();
  });

  it("mirrors an existing node into an isolated peer listener", () => {
    const plan = planAutoBridge(
      bridgeInput({
        mode: "bridge_existing_node",
        existingNodeId: "node-exit",
      }),
      {
        destinationAddress: "exit.example.test",
        existingNode,
        certificate,
      },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode === "reuse_peer_inbound") return;
    expect(plan).toMatchObject({
      mode: "bridge_existing_node",
      protocol: "trojan",
      sourceNodeId: "node-exit",
      certificateId: "cert-exit",
      tlsServerName: "exit.example.test",
      network: "both",
    });
    expect(plan.settings.tls).toMatchObject({ enabled: true });
    expect(
      (plan.settings.tls as Record<string, unknown>).server_name,
    ).toBeUndefined();
  });

  it("rejects a node protocol that cannot be a peer listener", () => {
    const plan = planAutoBridge(
      bridgeInput({
        mode: "bridge_existing_node",
        existingNodeId: "node-exit",
      }),
      {
        destinationAddress: "exit.example.test",
        existingNode: { ...existingNode, protocol: "direct" },
      },
    );
    expect(plan).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("reuses an existing destination peer listener", () => {
    const plan = planAutoBridge(
      bridgeInput({
        mode: "reuse_peer_inbound",
        existingPeerInboundId: existingInbound.id,
      }),
      { destinationAddress: "exit.example.test", existingInbound },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode !== "reuse_peer_inbound") return;
    expect(plan.inbound).toMatchObject({
      id: existingInbound.id,
      listenPort: existingInbound.listenPort,
      protocol: "vless",
    });
  });

  it("does not reuse an inbound from another server", () => {
    const plan = planAutoBridge(
      bridgeInput({
        mode: "reuse_peer_inbound",
        existingPeerInboundId: existingInbound.id,
      }),
      {
        destinationAddress: "exit.example.test",
        existingInbound: { ...existingInbound, serverId: "srv-other" },
      },
    );
    expect(plan).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("fullForwardRoutingRules", () => {
  it("routes every source subscriber inbound to the bridge outbound", () => {
    const rules = fullForwardRoutingRules("link-1", "peer-out-outbound-1", [
      "node-a",
      "node-b",
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      ruleId: "auto-bridge-link-1-node-a",
      inboundTags: ["node-node-a"],
      action: "route",
      outboundTag: "peer-out-outbound-1",
    });
    expect(rules[1]?.inboundTags).toEqual(["node-node-b"]);
  });
});

describe("networking input schemas", () => {
  it("keeps certificate-free non-TLS peer protocols valid", () => {
    const result = savePeerInboundSchema.safeParse({
      serverId: "srv-exit",
      expectedTopologyGeneration: 0,
      name: "Shadowsocks peer",
      protocol: "shadowsocks",
      listenAddress: "0.0.0.0",
      listenPort: 20002,
      advertisedAddress: "exit.example.test",
      advertisedPort: 20002,
      settings: { method: "2022-blake3-aes-128-gcm" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ network: "both" });
      expect(result.data.tlsServerName).toBeUndefined();
      expect(result.data.certificateId).toBeUndefined();
    }
  });

  it("requires TLS material for a required-TLS protocol unless Reality is on", () => {
    const missing = savePeerInboundSchema.safeParse({
      serverId: "srv-exit",
      expectedTopologyGeneration: 0,
      name: "Trojan peer",
      protocol: "trojan",
      listenAddress: "0.0.0.0",
      listenPort: 20003,
      advertisedAddress: "exit.example.test",
      advertisedPort: 20003,
      settings: {},
    });
    expect(missing.success).toBe(false);
    const reality = savePeerInboundSchema.safeParse({
      serverId: "srv-exit",
      expectedTopologyGeneration: 0,
      name: "Reality peer",
      protocol: "vless",
      listenAddress: "0.0.0.0",
      listenPort: 20004,
      advertisedAddress: "exit.example.test",
      advertisedPort: 20004,
      settings: { tls: { enabled: true, reality: { enabled: true } } },
    });
    expect(reality.success).toBe(true);
  });

  it("validates custom proxy outbound settings against the schema registry", () => {
    const valid = saveCustomProxyOutboundSchema.safeParse({
      serverId: "srv-transit",
      expectedTopologyGeneration: 0,
      name: "External shadowsocks",
      protocol: "shadowsocks",
      settings: {
        server: "external.example.test",
        server_port: 8388,
        method: "2022-blake3-aes-128-gcm",
        password: "secret",
      },
    });
    expect(valid.success).toBe(true);
    expect(
      saveCustomProxyOutboundSchema.safeParse({
        serverId: "srv-transit",
        expectedTopologyGeneration: 0,
        name: "Bad",
        protocol: "direct",
        settings: {},
      }).success,
    ).toBe(false);
    expect(
      saveCustomProxyOutboundSchema.safeParse({
        serverId: "srv-transit",
        expectedTopologyGeneration: 0,
        name: "Missing method",
        protocol: "shadowsocks",
        settings: { server: "external.example.test" },
      }).success,
    ).toBe(false);
  });

  it("validates outbound groups and keeps member tags unique", () => {
    const valid = saveOutboundGroupSchema.safeParse({
      serverId: "srv-transit",
      expectedTopologyGeneration: 0,
      name: "Auto select",
      protocol: "urltest",
      memberOutboundTags: ["direct", "custom-out-one"],
      settings: { url: "https://example.test/generate_204", interval: "5m" },
    });
    expect(valid.success).toBe(true);
    expect(
      saveOutboundGroupSchema.safeParse({
        serverId: "srv-transit",
        expectedTopologyGeneration: 0,
        name: "Dup",
        protocol: "selector",
        memberOutboundTags: ["direct", "direct"],
        settings: {},
      }).success,
    ).toBe(false);
  });

  it("requires the mode-specific existing resource", () => {
    expect(
      autoBridgeSchema.safeParse(
        bridgeInput({
          mode: "reuse_peer_inbound",
          existingPeerInboundId: undefined,
        }),
      ).success,
    ).toBe(false);
    expect(
      autoBridgeSchema.safeParse(bridgeInput({ mode: "bridge_existing_node" }))
        .success,
    ).toBe(false);
    expect(
      autoBridgeSchema.safeParse({
        ...bridgeInput(),
        destinationServerId: "srv-transit",
      }).success,
    ).toBe(false);
  });
});
