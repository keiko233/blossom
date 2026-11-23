import type { ManagedStageIntent } from "@blossom/contracts/agent-config-v3";
import {
  formatManagedPeerTlsBindingId,
  managedStageIntentSchema,
} from "@blossom/contracts/agent-config-v3";
import { encodePeerLinkIdentity } from "@blossom/domain/link-identity";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  compileManagedServerConfig,
  ManagedCompileError,
  managedPeerCredentialKey,
  type ManagedPeerTlsMaterial,
} from "./managed-singbox";
import {
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
  type CertificateArtifact,
  type SingboxConfig,
} from "./singbox";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const FP_C = "c".repeat(64);
const SRS_BYTES = Buffer.from([0x53, 0x52, 0x53, 0x01]);

function ruleSetArtifact() {
  return {
    ruleSetId: "geoip-cn",
    version: "20261120",
    format: "binary" as const,
    sha256: createHash("sha256").update(SRS_BYTES).digest("hex"),
    sizeBytes: SRS_BYTES.byteLength,
    contentBase64: SRS_BYTES.toString("base64"),
  };
}

function stageIntent(): ManagedStageIntent {
  return managedStageIntentSchema.parse({
    schemaVersion: 1,
    configVersionId: "mcv-1",
    serverId: "srv-1",
    version: 1,
    topologyGeneration: 1,
    subscriberInbounds: [
      {
        nodeId: "n1",
        inboundTag: "node-n1",
        protocol: "vless",
        listenPort: 443,
        tlsServerName: "edge-a.example.com",
        certificateId: "cert-sub-a",
        settingsDigest: `sha256:${"1".repeat(64)}`,
      },
      {
        nodeId: "n2",
        inboundTag: "node-n2",
        protocol: "trojan",
        listenPort: 8443,
        tlsServerName: "zero-a.example.com",
        certificateId: "cert-sub-a",
        settingsDigest: `sha256:${"2".repeat(64)}`,
      },
    ],
    peerInbounds: [
      {
        inboundId: "pin1",
        runtimeTag: "peer-in-pin1",
        protocol: "vless",
        listenAddress: "::",
        listenPort: 9443,
        advertisedAddress: "198.51.100.10",
        advertisedPort: 9443,
        tlsServerName: "peer-a.internal.example.com",
        certificateId: "cert-peer-a",
        certificateGeneration: 2,
        certificateFingerprintSha256: FP_A,
        admissions: [
          {
            linkId: "link-b-to-a",
            sourceServerId: "srv-b",
            credentialGeneration: 1,
          },
        ],
      },
    ],
    outbounds: [
      {
        outboundId: "dprof1",
        runtimeTag: "direct-dprof1",
        kind: "direct_profile",
        dialOptions: { bind_interface: "eth0" },
      },
      {
        outboundId: "pout1",
        runtimeTag: "peer-out-pout1",
        kind: "peer_link",
        dialOptions: {},
        linkId: "link-a-to-b",
        destinationServerId: "srv-b",
        destinationInboundId: "pin-b1",
        protocol: "trojan",
        serverAddress: "203.0.113.20",
        serverPort: 9443,
        tlsServerName: "peer-b.internal.example.com",
        credentialGeneration: 1,
        trustMode: "managed_certificate",
        trustedCertificates: [
          {
            certificateId: "cert-peer-b",
            generation: 5,
            fingerprintSha256: FP_B,
          },
        ],
      },
    ],
    routingPolicy: {
      finalOutboundTag: "direct",
      rules: [
        {
          ruleId: "rule-cn-to-b",
          inboundTags: ["node-n1", "node-n2"],
          sniff: true,
          resolveStrategy: "prefer_ipv4",
          network: null,
          ruleSetTags: ["rule-set-geoip-cn"],
          action: "route",
          outboundTag: "peer-out-pout1",
        },
        {
          ruleId: "rule-zero-user-only",
          inboundTags: ["node-n2"],
          action: "reject",
          outboundTag: null,
        },
      ],
    },
    ruleSets: [
      {
        runtimeTag: "rule-set-geoip-cn",
        ruleSetId: "geoip-cn",
        version: "20261120",
        format: "binary",
        sha256: ruleSetArtifact().sha256,
        sizeBytes: ruleSetArtifact().sizeBytes,
      },
    ],
    stageExpectations: {
      requiredRuntimeTags: [
        "node-n1",
        "peer-in-pin1",
        "direct-dprof1",
        "peer-out-pout1",
      ],
      removedRuntimeTags: [],
    },
  });
}

function tlsMaterial(intent: ManagedStageIntent): ManagedPeerTlsMaterial {
  const peer = intent.peerInbounds[0]!;
  const outbound = intent.outbounds[1]!;
  const trust = outbound.trustedCertificates[0]!;
  const receiver: CertificateArtifact = {
    certificateId: peer.certificateId,
    generation: peer.certificateGeneration,
    domains: [peer.tlsServerName],
    fingerprintSha256: peer.certificateFingerprintSha256,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    certificatePem: "PEER-A-CERT",
    privateKeyPem: "PEER-A-KEY",
  };
  const inboundBinding = {
    bindingId: formatManagedPeerTlsBindingId({
      direction: "inbound",
      ownerKind: "peer_inbound",
      ownerId: peer.inboundId,
      certificateId: peer.certificateId,
      generation: peer.certificateGeneration,
    }),
    runtimeTag: peer.runtimeTag,
    direction: "inbound" as const,
    ownerKind: "peer_inbound" as const,
    ownerId: peer.inboundId,
    certificateId: peer.certificateId,
    generation: peer.certificateGeneration,
    fingerprintSha256: peer.certificateFingerprintSha256,
    serverName: peer.tlsServerName,
    usage: "identity_fullchain_and_key" as const,
  };
  const trustBinding = {
    bindingId: formatManagedPeerTlsBindingId({
      direction: "outbound",
      ownerKind: "peer_outbound",
      ownerId: outbound.outboundId,
      certificateId: trust.certificateId,
      generation: trust.generation,
    }),
    runtimeTag: outbound.runtimeTag,
    direction: "outbound" as const,
    ownerKind: "peer_outbound" as const,
    ownerId: outbound.outboundId,
    certificateId: trust.certificateId,
    generation: trust.generation,
    fingerprintSha256: trust.fingerprintSha256,
    serverName: outbound.tlsServerName!,
    usage: "peer_ca_trust" as const,
  };
  return {
    inbound: [{ binding: inboundBinding, artifact: receiver }],
    outboundTrust: [
      {
        binding: trustBinding,
        artifact: {
          certificateId: trust.certificateId,
          generation: trust.generation,
          domains: ["peer-b.internal.example.com"],
          fingerprintSha256: trust.fingerprintSha256,
          notBefore: "2026-01-01T00:00:00.000Z",
          notAfter: "2027-01-01T00:00:00.000Z",
          certificatePem: "PEER-B-PUBLIC-CERT",
        },
      },
    ],
  };
}

function subscriberConfig(): SingboxConfig {
  return {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [{ tag: "bootstrap", type: "tls", server: "8.8.8.8" }],
    },
    inbounds: [
      {
        type: "vless",
        tag: "node-n1",
        listen: "::",
        listen_port: 443,
        tls: { enabled: true, server_name: "edge-a.example.com" },
      },
    ],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { rules: [], rule_set: [], final: "direct" },
  } as unknown as SingboxConfig;
}

function credentials(): Map<string, string> {
  return new Map([
    [
      managedPeerCredentialKey("link-a-to-b", 1),
      "550e8400-e29b-41d4-a716-446655440000",
    ],
    [
      managedPeerCredentialKey("link-b-to-a", 1),
      "550e8400-e29b-41d4-a716-446655440001",
    ],
  ]);
}

describe("managed snapshot compiler", () => {
  it("materializes frozen peer structure over live subscriber state without widening route scopes", () => {
    const intent = stageIntent();
    const result = compileManagedServerConfig({
      intent,
      subscriberConfig: subscriberConfig(),
      legacyRouteRules: [
        { domain_suffix: ["ads.example.com"], action: "reject" },
      ],
      ruleSetArtifacts: [ruleSetArtifact()],
      tlsMaterial: tlsMaterial(intent),
      peerCredentials: credentials(),
    });

    const inbounds = result.config.inbounds as unknown as {
      tag: string;
      users?: { name: string }[];
    }[];
    expect(inbounds.map((inbound) => inbound.tag)).toEqual([
      "node-n1",
      "peer-in-pin1",
    ]);
    expect(inbounds[1]?.users?.[0]?.name).toBe(
      encodePeerLinkIdentity("link-b-to-a", 1),
    );

    const outbounds = result.config.outbounds as unknown as {
      tag: string;
      tls?: Record<string, unknown>;
      domain_resolver?: string;
    }[];
    expect(outbounds.map((outbound) => outbound.tag)).toEqual([
      "direct",
      "direct-dprof1",
      "peer-out-pout1",
    ]);
    expect(outbounds[2]?.tls).toMatchObject({
      enabled: true,
      server_name: "peer-b.internal.example.com",
    });
    expect(outbounds[2]?.tls?.certificate_path).toBeUndefined();
    expect(outbounds[2]?.tls?.insecure).toBeUndefined();
    // An IP endpoint needs no peer DNS bootstrap.
    expect(outbounds[2]?.domain_resolver).toBeUndefined();

    const route = result.config.route as unknown as {
      rules: {
        action: string;
        inbound?: string[];
        network?: string;
        outbound?: string;
      }[];
      final: string;
      rule_set: { tag: string; path?: string }[];
    };
    expect(route.final).toBe("direct");
    expect(route.rule_set[0]?.tag).toBe("rule-set-geoip-cn");
    expect(route.rule_set[0]?.path).toContain("/blossom-managed/rule-sets/");
    expect(route.rules).toEqual([
      {
        domain_suffix: ["ads.example.com"],
        action: "reject",
        inbound: ["node-n1"],
      },
      { action: "sniff", inbound: ["node-n1"] },
      {
        action: "resolve",
        strategy: "prefer_ipv4",
        inbound: ["node-n1"],
      },
      {
        outbound: "peer-out-pout1",
        rule_set: ["rule-set-geoip-cn"],
        inbound: ["node-n1"],
        network: "tcp",
      },
      {
        action: "reject",
        rule_set: ["rule-set-geoip-cn"],
        inbound: ["node-n1"],
        network: "udp",
      },
      { action: "reject", inbound: ["peer-in-pin1"] },
    ]);
    // The zero-user node is absent, so its reject rule disappears rather than
    // becoming an unscoped global match.
    expect(route.rules.some((rule) => rule.inbound?.includes("node-n2"))).toBe(
      false,
    );

    expect(result.extension.intentDigest).toBe(
      computeManagedStageIntentDigest(intent),
    );
    expect(result.extension.managedFingerprint).toBe(
      computeManagedStateFingerprint(intent),
    );
    expect(result.extension.tlsBindings).toHaveLength(2);
    expect(result.extension.peerTrustArtifacts[0]).not.toHaveProperty(
      "privateKeyPem",
    );
    expect(result.probeBindings).toEqual([
      {
        linkId: "link-a-to-b",
        credentialGeneration: 1,
        sourceServerId: "srv-1",
        destinationServerId: "srv-b",
        sourceOutboundTag: "peer-out-pout1",
        destinationInboundTag: null,
      },
      {
        linkId: "link-b-to-a",
        credentialGeneration: 1,
        sourceServerId: "srv-b",
        destinationServerId: "srv-1",
        sourceOutboundTag: null,
        destinationInboundTag: "peer-in-pin1",
      },
    ]);
    expect(result.extension.probeBindings).toEqual(result.probeBindings);
    expect(result.peerCertificateArtifacts).toEqual([
      expect.objectContaining({
        certificateId: "cert-peer-a",
        generation: 2,
        privateKeyPem: "PEER-A-KEY",
      }),
    ]);
  });

  it("maps every source link to its own outbound and keeps remote tags local-only", () => {
    const intent = stageIntent();
    const secondOutbound = {
      ...intent.outbounds[1]!,
      outboundId: "pout2",
      runtimeTag: "peer-out-pout2",
      linkId: "link-a-to-c",
      destinationServerId: "srv-c",
      destinationInboundId: "pin-c1",
      serverAddress: "203.0.113.30",
      tlsServerName: "peer-c.internal.example.com",
      trustedCertificates: [
        {
          certificateId: "cert-peer-c",
          generation: 7,
          fingerprintSha256: FP_C,
        },
      ],
    };
    intent.outbounds.push(secondOutbound);
    const baseMaterial = tlsMaterial(intent);
    const secondTrust = secondOutbound.trustedCertificates[0]!;
    const secondBinding = {
      bindingId: formatManagedPeerTlsBindingId({
        direction: "outbound",
        ownerKind: "peer_outbound",
        ownerId: secondOutbound.outboundId,
        certificateId: secondTrust.certificateId,
        generation: secondTrust.generation,
      }),
      runtimeTag: secondOutbound.runtimeTag,
      direction: "outbound" as const,
      ownerKind: "peer_outbound" as const,
      ownerId: secondOutbound.outboundId,
      certificateId: secondTrust.certificateId,
      generation: secondTrust.generation,
      fingerprintSha256: secondTrust.fingerprintSha256,
      serverName: secondOutbound.tlsServerName!,
      usage: "peer_ca_trust" as const,
    };
    const material: ManagedPeerTlsMaterial = {
      inbound: baseMaterial.inbound,
      outboundTrust: [
        ...baseMaterial.outboundTrust,
        {
          binding: secondBinding,
          artifact: {
            certificateId: secondTrust.certificateId,
            generation: secondTrust.generation,
            domains: ["peer-c.internal.example.com"],
            fingerprintSha256: secondTrust.fingerprintSha256,
            notBefore: "2026-01-01T00:00:00.000Z",
            notAfter: "2027-01-01T00:00:00.000Z",
            certificatePem: "PEER-C-PUBLIC-CERT",
          },
        },
      ],
    };
    const peerCredentials = credentials();
    peerCredentials.set(
      managedPeerCredentialKey("link-a-to-c", 1),
      "550e8400-e29b-41d4-a716-446655440002",
    );
    const result = compileManagedServerConfig({
      intent,
      subscriberConfig: subscriberConfig(),
      ruleSetArtifacts: [ruleSetArtifact()],
      tlsMaterial: material,
      peerCredentials,
    });

    expect(
      result.probeBindings
        .filter((binding) => binding.sourceOutboundTag !== null)
        .map((binding) => [
          binding.linkId,
          binding.sourceOutboundTag,
          binding.destinationInboundTag,
        ]),
    ).toEqual([
      ["link-a-to-b", "peer-out-pout1", null],
      ["link-a-to-c", "peer-out-pout2", null],
    ]);
    expect(
      result.probeBindings.every(
        (binding) =>
          binding.destinationInboundTag !== "pin-c1" &&
          binding.destinationInboundTag !== "peer-in-pin-b1",
      ),
    ).toBe(true);

    const reversed = {
      ...intent,
      peerInbounds: [...intent.peerInbounds].reverse(),
      outbounds: [...intent.outbounds].reverse(),
    };
    const replay = compileManagedServerConfig({
      intent: reversed,
      subscriberConfig: subscriberConfig(),
      ruleSetArtifacts: [ruleSetArtifact()],
      tlsMaterial: material,
      peerCredentials,
    });
    expect(replay.probeBindings).toEqual(result.probeBindings);
    expect(replay.managedFingerprint).toBe(result.managedFingerprint);
  });

  it("rejects a duplicate link identity instead of guessing a probe target", () => {
    const intent = stageIntent();
    intent.peerInbounds[0]!.admissions[0]!.linkId = "link-a-to-b";
    expect(() =>
      compileManagedServerConfig({
        intent,
        subscriberConfig: subscriberConfig(),
        ruleSetArtifacts: [ruleSetArtifact()],
        tlsMaterial: tlsMaterial(intent),
        peerCredentials: credentials(),
      }),
    ).toThrow(/duplicate probe binding/);
  });

  it("keeps a hostname peer endpoint on direct DNS rather than the link", () => {
    const intent = stageIntent();
    intent.outbounds[1]!.serverAddress = "peer-b.example.com";
    const result = compileManagedServerConfig({
      intent,
      subscriberConfig: subscriberConfig(),
      ruleSetArtifacts: [ruleSetArtifact()],
      tlsMaterial: tlsMaterial(intent),
      peerCredentials: credentials(),
    });
    const peer = (
      result.config.outbounds as unknown as {
        tag: string;
        domain_resolver?: string;
      }[]
    ).find((outbound) => outbound.tag === "peer-out-pout1");
    expect(peer?.domain_resolver).toBe("bootstrap");
  });

  it("fails closed when a pinned artifact or credential is missing", () => {
    const intent = stageIntent();
    expect(() =>
      compileManagedServerConfig({
        intent,
        subscriberConfig: subscriberConfig(),
        ruleSetArtifacts: [],
        tlsMaterial: tlsMaterial(intent),
        peerCredentials: credentials(),
      }),
    ).toThrowError(ManagedCompileError);
    expect(() =>
      compileManagedServerConfig({
        intent,
        subscriberConfig: subscriberConfig(),
        ruleSetArtifacts: [ruleSetArtifact()],
        tlsMaterial: { inbound: [], outboundTrust: [] },
        peerCredentials: credentials(),
      }),
    ).toThrowError(ManagedCompileError);
    expect(() =>
      compileManagedServerConfig({
        intent,
        subscriberConfig: subscriberConfig(),
        ruleSetArtifacts: [ruleSetArtifact()],
        tlsMaterial: tlsMaterial(intent),
        peerCredentials: new Map(),
      }),
    ).toThrowError(ManagedCompileError);
  });

  it("rejects UDP routing through a TCP-only peer outbound", () => {
    const intent = stageIntent();
    intent.routingPolicy.rules[0]!.network = "udp";
    expect(() =>
      compileManagedServerConfig({
        intent,
        subscriberConfig: subscriberConfig(),
        ruleSetArtifacts: [ruleSetArtifact()],
        tlsMaterial: tlsMaterial(intent),
        peerCredentials: credentials(),
      }),
    ).toThrowError(/TCP-only peer outbound/);
  });

  it("drops a peer listener with no admission and ships no receiver private key", () => {
    const intent = stageIntent();
    intent.peerInbounds[0]!.admissions = [];
    const result = compileManagedServerConfig({
      intent,
      subscriberConfig: subscriberConfig(),
      ruleSetArtifacts: [ruleSetArtifact()],
      tlsMaterial: tlsMaterial(intent),
      peerCredentials: credentials(),
    });
    expect(result.prunedPeerInboundTags).toEqual(["peer-in-pin1"]);
    expect(result.peerCertificateArtifacts).toEqual([]);
    expect(result.extension.tlsBindings).toHaveLength(1);
    expect(result.extension.tlsBindings[0]?.direction).toBe("outbound");
  });
});
