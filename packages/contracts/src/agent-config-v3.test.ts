import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_V3_API_VERSION,
  agentConfigV3OutputSchema,
  deriveManagedProbeBindings,
  formatManagedPeerTlsBindingId,
  MANAGED_NETWORKING_V2_CAPABILITY,
  MANAGED_SNAPSHOT_LIMITS,
  managedIntentOutboundSchema,
  managedIntentPeerInboundSchema,
  managedIntentPortForwardSchema,
  managedPeerCertificateDeploymentSchema,
  managedPeerTlsBindingSchema,
  managedProbeBindingSchema,
  managedRuleSetBindingSchema,
  managedStageIntentSchema,
  validateManagedProbeBindings,
} from "./agent-config-v3";

const fixtureFile = JSON.parse(
  readFileSync(
    new URL("../fixtures/agent-config-v3.snapshots.json", import.meta.url),
    "utf8",
  ),
) as {
  apiVersion: number;
  capability: string;
  budgets: {
    maxRuleSetAssetRawBytes: number;
    maxRuleSetAggregateRawBytes: number;
    maxActivationPreviewBytes: number;
    maxWireSnapshotBytes: number;
  };
  stageIntent: unknown;
  snapshots: {
    name: string;
    expect: "ok" | "invalid";
    kind: "legacy" | "managed";
    document: unknown;
  }[];
};

describe("agent config v3 shared contracts", () => {
  it("pins the capability name and byte budgets from the reviewed spec", () => {
    expect(fixtureFile.apiVersion).toBe(AGENT_CONFIG_V3_API_VERSION);
    expect(fixtureFile.capability).toBe(MANAGED_NETWORKING_V2_CAPABILITY);
    expect(fixtureFile.budgets).toEqual({
      maxRuleSetAssetRawBytes: MANAGED_SNAPSHOT_LIMITS.maxRuleSetAssetRawBytes,
      maxRuleSetAggregateRawBytes:
        MANAGED_SNAPSHOT_LIMITS.maxRuleSetAggregateRawBytes,
      maxActivationPreviewBytes:
        MANAGED_SNAPSHOT_LIMITS.maxActivationPreviewBytes,
      maxWireSnapshotBytes: MANAGED_SNAPSHOT_LIMITS.maxWireSnapshotBytes,
    });
  });

  it("parses the pinned stage intent fixture", () => {
    const parsed = managedStageIntentSchema.safeParse(fixtureFile.stageIntent);
    expect(parsed.success).toBe(true);
  });

  it.each(fixtureFile.snapshots.map((entry) => [entry.name, entry] as const))(
    "validates snapshot fixture %s",
    (_name, entry) => {
      const parsed = agentConfigV3OutputSchema.safeParse(entry.document);
      if (entry.expect === "ok") {
        expect(parsed.success).toBe(true);
        if (parsed.success && entry.kind === "legacy") {
          expect(parsed.data.managed).toBeUndefined();
        }
        if (parsed.success && entry.kind === "managed") {
          expect(parsed.data.managed?.schemaVersion).toBe(1);
        }
      } else {
        expect(parsed.success).toBe(false);
      }
    },
  );

  it("enforces peer TLS direction, runtime tag, usage and deployment invariants", () => {
    const bindingId = formatManagedPeerTlsBindingId({
      direction: "outbound",
      ownerKind: "peer_outbound",
      ownerId: "pout1",
      certificateId: "cert-peer-b",
      generation: 5,
    });
    expect(
      managedPeerTlsBindingSchema.safeParse({
        bindingId,
        runtimeTag: "peer-out-pout1",
        direction: "outbound",
        ownerKind: "peer_outbound",
        ownerId: "pout1",
        certificateId: "cert-peer-b",
        generation: 5,
        fingerprintSha256: "f".repeat(64),
        serverName: "peer-b.internal.example.com",
        usage: "peer_ca_trust",
      }).success,
    ).toBe(true);

    expect(
      managedPeerCertificateDeploymentSchema.safeParse({
        bindingId,
        runtimeTag: "peer-out-pout1",
        direction: "outbound",
        ownerKind: "peer_outbound",
        ownerId: "pout1",
        certificateId: "cert-peer-b",
        generation: 5,
        fingerprintSha256: "f".repeat(64),
        installed: false,
        inUse: true,
      }).success,
    ).toBe(false);
  });

  it("derives one deterministic local-side probe tag per link identity", () => {
    const intent = managedStageIntentSchema.parse(fixtureFile.stageIntent);
    expect(deriveManagedProbeBindings(intent)).toEqual([
      {
        linkId: "link-a-to-b",
        credentialGeneration: 3,
        sourceServerId: "srv-a",
        destinationServerId: "srv-b",
        sourceOutboundTag: "peer-out-pout1",
        destinationInboundTag: null,
      },
      {
        linkId: "link-c-to-a",
        credentialGeneration: 1,
        sourceServerId: "srv-c",
        destinationServerId: "srv-a",
        sourceOutboundTag: null,
        destinationInboundTag: "peer-in-pin1",
      },
    ]);
  });

  it("rejects ambiguous, duplicate and self probe bindings", () => {
    const source = {
      linkId: "link-a-to-b",
      credentialGeneration: 1,
      sourceServerId: "srv-a",
      destinationServerId: "srv-b",
      sourceOutboundTag: "peer-out-pout1",
      destinationInboundTag: null,
    };
    const receiver = {
      linkId: "link-c-to-a",
      credentialGeneration: 1,
      sourceServerId: "srv-c",
      destinationServerId: "srv-a",
      sourceOutboundTag: null,
      destinationInboundTag: "peer-in-pin1",
    };
    expect(validateManagedProbeBindings([receiver, source])).toEqual([
      source,
      receiver,
    ]);
    expect(
      validateManagedProbeBindings([
        source,
        { ...receiver, destinationInboundTag: "peer-in-pin1" },
      ]),
    ).toHaveLength(2);
    expect(() => validateManagedProbeBindings([source, { ...source }])).toThrow(
      /duplicate probe binding/,
    );
    expect(() =>
      validateManagedProbeBindings([
        source,
        {
          ...source,
          linkId: "link-d-to-b",
          destinationInboundTag: null,
        },
      ]),
    ).toThrow(/ambiguous probe source outbound/);
    expect(
      managedProbeBindingSchema.safeParse({
        ...source,
        sourceOutboundTag: null,
        destinationInboundTag: null,
      }).success,
    ).toBe(false);
    expect(
      managedProbeBindingSchema.safeParse({
        ...source,
        destinationServerId: "srv-a",
      }).success,
    ).toBe(false);
    expect(
      managedProbeBindingSchema.safeParse({
        ...source,
        sourceOutboundTag: "direct",
      }).success,
    ).toBe(false);
    expect(
      managedProbeBindingSchema.safeParse({
        ...receiver,
        destinationInboundTag: "node-n1",
      }).success,
    ).toBe(false);
  });

  it("requires rule-set runtimeTag to match rule-set-<ruleSetId> and bounds raw bytes", () => {
    expect(
      managedRuleSetBindingSchema.safeParse({
        runtimeTag: "rule-set-geoip-cn",
        ruleSetId: "geoip-cn",
        version: "20261120",
        format: "binary",
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        sizeBytes: 512 * 1024,
      }).success,
    ).toBe(true);

    expect(
      managedRuleSetBindingSchema.safeParse({
        runtimeTag: "wrong-tag",
        ruleSetId: "geoip-cn",
        version: "20261120",
        format: "binary",
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        sizeBytes: 128,
      }).success,
    ).toBe(false);
  });

  it("accepts non-TLS peer inbounds, custom_proxy, outbound_group, and port forwards", () => {
    expect(
      managedIntentPeerInboundSchema.safeParse({
        inboundId: "ss1",
        runtimeTag: "peer-in-ss1",
        protocol: "shadowsocks",
        listenAddress: "::",
        listenPort: 18388,
        advertisedAddress: "203.0.113.10",
        advertisedPort: 18388,
        network: "both",
        settings: { method: "2022-blake3-aes-128-gcm" },
        admissions: [
          {
            linkId: "link-1",
            sourceServerId: "srv-a",
            credentialGeneration: 1,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      managedIntentOutboundSchema.safeParse({
        outboundId: "cp1",
        runtimeTag: "custom-out-cp1",
        kind: "custom_proxy",
        protocol: "socks",
        settings: { server: "198.51.100.2", server_port: 1080 },
      }).success,
    ).toBe(true);

    expect(
      managedIntentOutboundSchema.safeParse({
        outboundId: "grp1",
        runtimeTag: "group-out-grp1",
        kind: "outbound_group",
        protocol: "urltest",
        memberOutboundTags: ["peer-out-p1", "custom-out-cp1"],
      }).success,
    ).toBe(true);

    expect(
      managedIntentPortForwardSchema.safeParse({
        forwardId: "pf1",
        runtimeTag: "relay-in-pf1",
        listenAddress: "::",
        listenPort: 10443,
        network: "both",
        overrideAddress: "203.0.113.20",
        overridePort: 443,
      }).success,
    ).toBe(true);
  });
});
