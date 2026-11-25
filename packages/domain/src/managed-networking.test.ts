import { describe, expect, it } from "vitest";

import {
  agentOwnedRuntimeTag,
  BUILTIN_DIRECT_OUTBOUND_TAG,
  classifyManagedRuntimeTag,
  directProfileIpFamilyDialFields,
  estimateBase64EncodedBytes,
  evaluateManagedNetworkingReadiness,
  evaluateManagedSnapshotByteBudget,
  isPeerProtocol,
  isReservedRuntimeTag,
  MANAGED_NETWORKING_ACTIVATION_ENABLED,
  MANAGED_NETWORKING_AGENT_CAPABILITY,
  MANAGED_NETWORKING_MIN_SING_BOX_VERSION,
  MANAGED_SNAPSHOT_BYTE_BUDGETS,
  managedRuntimeTag,
  parseSingBoxVersion,
  peerProtocolCapability,
  subscriberInboundTag,
} from "./managed-networking";

describe("managedRuntimeTag", () => {
  it("derives distinct tags per kind that cannot collide with subscriber or built-in tags", () => {
    const tags = [
      managedRuntimeTag("peer_inbound", "abc"),
      managedRuntimeTag("peer_link", "abc"),
      managedRuntimeTag("direct_profile", "abc"),
      managedRuntimeTag("rule_set", "geoip-cn"),
    ];
    expect(tags).toEqual([
      "peer-in-abc",
      "peer-out-abc",
      "direct-abc",
      "rule-set-geoip-cn",
    ]);
    for (const tag of tags) {
      expect(tag.startsWith("node-")).toBe(false);
      expect(tag.startsWith("blossom-agent-")).toBe(false);
      expect(tag).not.toBe(BUILTIN_DIRECT_OUTBOUND_TAG);
    }
  });

  it("classifies subscriber, managed, built-in and agent-owned runtime tags unambiguously", () => {
    expect(classifyManagedRuntimeTag("direct")).toEqual({
      kind: "builtin_direct",
      tag: "direct",
    });
    expect(classifyManagedRuntimeTag(subscriberInboundTag("n1"))).toEqual({
      kind: "subscriber_inbound",
      id: "n1",
      tag: "node-n1",
    });
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("peer_inbound", "pin1")),
    ).toEqual({
      kind: "peer_inbound",
      id: "pin1",
      tag: "peer-in-pin1",
    });
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("peer_link", "pout1")),
    ).toEqual({
      kind: "peer_link",
      id: "pout1",
      tag: "peer-out-pout1",
    });
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("direct_profile", "d1")),
    ).toEqual({
      kind: "direct_profile",
      id: "d1",
      tag: "direct-d1",
    });
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("rule_set", "rs1")),
    ).toEqual({
      kind: "rule_set",
      id: "rs1",
      tag: "rule-set-rs1",
    });
    expect(classifyManagedRuntimeTag(agentOwnedRuntimeTag("probe-in"))).toEqual(
      {
        kind: "agent_owned",
        purpose: "probe-in",
        tag: "blossom-agent-probe-in",
      },
    );
    expect(classifyManagedRuntimeTag("peer-in-")).toBeNull();
    expect(classifyManagedRuntimeTag("custom-tag")).toBeNull();
    expect(isReservedRuntimeTag("peer-in-")).toBe(true);
    expect(isReservedRuntimeTag("blossom-agent-probe")).toBe(true);
    expect(isReservedRuntimeTag("custom-tag")).toBe(false);
  });

  it("rejects an empty identity", () => {
    expect(() => managedRuntimeTag("peer_inbound", "")).toThrow();
    expect(() => subscriberInboundTag("")).toThrow();
    expect(() => agentOwnedRuntimeTag("")).toThrow();
  });
});

describe("evaluateManagedSnapshotByteBudget", () => {
  it("accepts a snapshot within per-asset, aggregate, preview and wire caps", () => {
    const result = evaluateManagedSnapshotByteBudget({
      stage: "activation_preview",
      ruleSets: [
        {
          ruleSetId: "geoip-cn",
          rawBytes: MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes,
        },
        {
          ruleSetId: "geosite-cn",
          rawBytes: MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes,
        },
      ],
      serializedSnapshotBytes:
        MANAGED_SNAPSHOT_BYTE_BUDGETS.maxActivationPreviewSerializedBytes,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(estimateBase64EncodedBytes(16)).toBe(24);
  });

  it("reports per-asset, aggregate, preview and wire violations distinctly", () => {
    const perAsset = MANAGED_SNAPSHOT_BYTE_BUDGETS.maxRuleSetAssetRawBytes + 1;
    const result = evaluateManagedSnapshotByteBudget({
      stage: "activation_preview",
      ruleSets: [
        { ruleSetId: "rs-1", rawBytes: perAsset },
        { ruleSetId: "rs-2", rawBytes: 512 * 1024 },
        { ruleSetId: "rs-3", rawBytes: 512 * 1024 },
        { ruleSetId: "rs-4", rawBytes: 512 * 1024 },
      ],
      serializedSnapshotBytes:
        MANAGED_SNAPSHOT_BYTE_BUDGETS.maxLiveSnapshotWireBytes + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual([
      "rule_set_asset_too_large",
      "rule_set_aggregate_too_large",
      "preview_budget_exceeded",
      "wire_cap_exceeded",
    ]);

    const liveWithinWire = evaluateManagedSnapshotByteBudget({
      stage: "live_compile",
      ruleSets: [],
      serializedSnapshotBytes:
        MANAGED_SNAPSHOT_BYTE_BUDGETS.maxActivationPreviewSerializedBytes +
        1024,
    });
    expect(liveWithinWire.ok).toBe(true);
  });
});

describe("managed activation", () => {
  it("enables managed rollout by default", () => {
    expect(MANAGED_NETWORKING_ACTIVATION_ENABLED).toBe(true);
  });
});

describe("managed activation readiness", () => {
  const ready = {
    enabled: true,
    agentConnected: true,
    agentCapabilities: [MANAGED_NETWORKING_AGENT_CAPABILITY],
    singBoxVersion: "1.14.4",
    runtimeState: "running",
    configState: "applied",
    desiredConfigVersionId: null,
    appliedConfigVersionId: null,
  };

  it("accepts a connected capability-bearing agent on a settled runtime", () => {
    expect(evaluateManagedNetworkingReadiness(ready)).toEqual({
      ready: true,
      reasons: [],
      minSingBoxVersion: MANAGED_NETWORKING_MIN_SING_BOX_VERSION,
    });
  });

  it("reports every blocking reason instead of treating unknown state as compatible", () => {
    expect(
      evaluateManagedNetworkingReadiness({
        enabled: false,
        agentConnected: false,
        agentCapabilities: [],
        singBoxVersion: null,
        runtimeState: "unknown",
        configState: "unknown",
        desiredConfigVersionId: "cfg-new",
        appliedConfigVersionId: "cfg-old",
      }),
    ).toMatchObject({
      ready: false,
      reasons: [
        "server_disabled",
        "agent_offline",
        "capability_missing",
        "sing_box_version_unknown",
        "runtime_state_unknown",
        "config_state_unknown",
        "managed_state_unsettled",
      ],
    });
  });

  it("rejects a version below the managed floor", () => {
    expect(
      evaluateManagedNetworkingReadiness({
        ...ready,
        singBoxVersion: "1.13.9",
      }).reasons,
    ).toEqual(["sing_box_version_unsupported"]);
  });
});

describe("parseSingBoxVersion", () => {
  it("accepts the agent's plain and v-prefixed versions", () => {
    expect(parseSingBoxVersion("1.14.4")).toEqual({
      major: 1,
      minor: 14,
      patch: 4,
    });
    expect(parseSingBoxVersion("v1.14.4-beta.1")).toEqual({
      major: 1,
      minor: 14,
      patch: 4,
    });
    expect(parseSingBoxVersion("sing-box 1.14.4")).toBeNull();
    expect(parseSingBoxVersion(null)).toBeNull();
  });
});

describe("directProfileIpFamilyDialFields", () => {
  it("maps only the explicit family, leaving any at the sing-box defaults", () => {
    expect(directProfileIpFamilyDialFields("any")).toEqual({});
    expect(directProfileIpFamilyDialFields("ipv4")).toEqual({ inet6: false });
    expect(directProfileIpFamilyDialFields("ipv6")).toEqual({ inet4: false });
  });
});

describe("extended managed runtime tags and peer protocol capabilities", () => {
  it("classifies port_forward, custom_proxy, and outbound_group tags unambiguously", () => {
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("port_forward", "pf1")),
    ).toEqual({
      kind: "port_forward",
      id: "pf1",
      tag: "relay-in-pf1",
    });
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("custom_proxy", "cp1")),
    ).toEqual({
      kind: "custom_proxy",
      id: "cp1",
      tag: "custom-out-cp1",
    });
    expect(
      classifyManagedRuntimeTag(managedRuntimeTag("outbound_group", "g1")),
    ).toEqual({
      kind: "outbound_group",
      id: "g1",
      tag: "group-out-g1",
    });
    expect(isReservedRuntimeTag("relay-in-pf1")).toBe(true);
    expect(isReservedRuntimeTag("custom-out-cp1")).toBe(true);
    expect(isReservedRuntimeTag("group-out-g1")).toBe(true);
  });

  it("exposes capabilities for multi-protocol peering", () => {
    expect(isPeerProtocol("shadowsocks")).toBe(true);
    expect(isPeerProtocol("hysteria2")).toBe(true);
    expect(isPeerProtocol("socks")).toBe(true);
    expect(isPeerProtocol("unknown_proto")).toBe(false);
    expect(peerProtocolCapability("shadowsocks")).toMatchObject({
      supportsUdp: true,
      tlsMode: "none",
      quicTransport: false,
    });
    expect(peerProtocolCapability("hysteria2")).toMatchObject({
      supportsUdp: true,
      tlsMode: "required",
      quicTransport: true,
    });
    expect(peerProtocolCapability("vless")).toMatchObject({
      supportsUdp: true,
      tlsMode: "optional",
    });
  });
});
