import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_V3_API_VERSION,
  agentConfigV3OutputSchema,
  formatManagedPeerTlsBindingId,
  MANAGED_NETWORKING_V2_CAPABILITY,
  MANAGED_SNAPSHOT_LIMITS,
  managedPeerCertificateDeploymentSchema,
  managedPeerTlsBindingSchema,
  managedRuleSetBindingSchema,
  managedStageIntentSchema,
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
});
