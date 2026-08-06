import { describe, expect, it } from "vitest";

import type { Node } from "@/db/proxy-schema";

import {
  buildCertificateArtifacts,
  buildGenerationByCertificateId,
  buildManagedTlsBindings,
  canonicalize,
  compileServerConfig,
  computeDesiredRevision,
  decideCertificateDeployment,
  filterCertificateArtifactsForBindings,
  type CertificateArtifact,
  type CertificateArtifactContext,
  type ManagedTlsBinding,
} from "./singbox";
import { encodeTrafficUser } from "./traffic-user-codec";

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";

function makeNode(
  id: string,
  protocol: string,
  certificateId?: string | null,
): Node {
  return {
    id,
    name: `${id}-name`,
    remark: null,
    tags: [],
    enabled: true,
    serverId: "srv-1",
    address: null,
    listenPort: 443,
    protocol,
    certificateId: certificateId ?? null,
    tlsServerName: null,
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Node;
}

function compiledConfig() {
  const node = makeNode("n1", "vless");
  node.settings = { tls: { enabled: true } };
  return compileServerConfig({
    inbounds: [
      {
        node,
        users: [{ name: encodeTrafficUser("n1", "s1"), uuid: UUID_A }],
      },
    ],
  });
}

function sampleBindings(): ManagedTlsBinding[] {
  return [
    {
      nodeId: "n2",
      inboundTag: "node-n2",
      certificateId: "cert-1",
      generation: 3,
      serverName: "b.example.com",
    },
    {
      nodeId: "n1",
      inboundTag: "node-n1",
      certificateId: "cert-1",
      generation: 3,
      serverName: "a.example.com",
    },
  ];
}

function sampleArtifacts(): CertificateArtifact[] {
  return [
    {
      certificateId: "cert-1",
      generation: 3,
      domains: ["a.example.com", "b.example.com"],
      fingerprintSha256: "fp-1",
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
      certificatePem: "CERT-A",
      privateKeyPem: "KEY-A",
    },
  ];
}

/** Rebuilds a value with object keys in reverse insertion order. */
function withReversedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withReversedKeys) as T;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      out[key] = withReversedKeys(child);
    }
    return out as T;
  }
  return value;
}

describe("canonicalize", () => {
  it("is independent of object key insertion order", () => {
    expect(canonicalize({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(
      canonicalize({ a: [1, { x: 1, y: 2 }], b: 1 }),
    );
  });
});

describe("computeDesiredRevision", () => {
  it("is stable across identical snapshots regardless of key order", () => {
    const config = compiledConfig();
    const bindings = sampleBindings();
    const artifacts = sampleArtifacts();

    const revision = computeDesiredRevision(config, bindings, artifacts, [
      "n1",
    ]);
    const reordered = computeDesiredRevision(
      withReversedKeys(config),
      withReversedKeys(bindings),
      withReversedKeys(artifacts),
      ["n1"],
    );
    expect(reordered).toBe(revision);
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not hash PEM bytes directly when a fingerprint is available", () => {
    const config = compiledConfig();
    const bindings = sampleBindings();
    const artifacts = sampleArtifacts();
    const revision = computeDesiredRevision(config, bindings, artifacts, [
      "n1",
    ]);

    const differentPem = artifacts.map((a) => ({
      ...a,
      certificatePem: "CERT-B",
      privateKeyPem: "KEY-B",
    }));
    expect(computeDesiredRevision(config, bindings, differentPem, ["n1"])).toBe(
      revision,
    );

    const differentFingerprint = artifacts.map((a) => ({
      ...a,
      fingerprintSha256: "fp-2",
    }));
    expect(
      computeDesiredRevision(config, bindings, differentFingerprint, ["n1"]),
    ).not.toBe(revision);
  });

  it("changes when the desired generation, node ids, or config change", () => {
    const config = compiledConfig();
    const bindings = sampleBindings();
    const artifacts = sampleArtifacts();
    const revision = computeDesiredRevision(config, bindings, artifacts, [
      "n1",
    ]);

    expect(
      computeDesiredRevision(
        config,
        bindings.map((b) => ({ ...b, generation: 4 })),
        artifacts,
        ["n1"],
      ),
    ).not.toBe(revision);
    expect(
      computeDesiredRevision(config, bindings, artifacts, ["n1", "n2"]),
    ).not.toBe(revision);
    const nextConfig = compiledConfig();
    (
      nextConfig as unknown as { inbounds: { users: { uuid: string }[] }[] }
    ).inbounds[0].users[0].uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(
      computeDesiredRevision(nextConfig, bindings, artifacts, ["n1"]),
    ).not.toBe(revision);
  });
});

describe("buildManagedTlsBindings", () => {
  it("sorts by nodeId and emits only enabled TLS nodes bound to a certificate", () => {
    const n1 = makeNode("n1", "vless", "cert-1");
    const n2 = makeNode("n2", "vless", "cert-1");
    n2.settings = { tls: { enabled: true } };
    n2.tlsServerName = "b.example.com";
    const n3 = makeNode("n3", "vless", "cert-1");
    n3.settings = { tls: { enabled: true } };
    n3.tlsServerName = "c.example.com";
    const n4 = makeNode("n4", "vless", "cert-2");
    n4.settings = { tls: { enabled: true } };
    const n5 = makeNode("n5", "vless", "cert-1");
    n5.settings = { tls: { enabled: true, reality: { enabled: true } } };

    const bindings = buildManagedTlsBindings(
      [n4, n5, n3, n1, n2],
      new Map([["cert-1", 3]]),
    );
    expect(bindings.map((b) => b.nodeId)).toEqual(["n2", "n3"]);
    expect(bindings[0]).toEqual({
      nodeId: "n2",
      inboundTag: "node-n2",
      certificateId: "cert-1",
      generation: 3,
      serverName: "b.example.com",
    });
  });

  it("falls back to null serverName when the node has none", () => {
    const node = makeNode("n1", "vless", "cert-1");
    node.settings = { tls: { enabled: true } };
    const bindings = buildManagedTlsBindings([node], new Map([["cert-1", 2]]));
    expect(bindings[0]?.serverName).toBeNull();
  });
});

describe("buildCertificateArtifacts", () => {
  const base: CertificateArtifactContext = {
    certificate: {
      id: "cert-1",
      domains: ["a.example.com"],
      activeMaterialVersion: 3,
    },
    binding: { enabled: true, desiredGeneration: 3 },
    material: {
      certificatePem: "CERT",
      privateKeyPem: "KEY",
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
      fingerprintSha256: "fp-1",
    },
  };

  it("emits only enabled bindings with active material, deduped", () => {
    const context: CertificateArtifactContext[] = [
      { ...base },
      { ...base },
      { ...base, binding: { enabled: false, desiredGeneration: 3 } },
      {
        ...base,
        certificate: { ...base.certificate, id: "cert-2" },
      },
      { ...base, material: undefined },
    ];
    const artifacts = buildCertificateArtifacts(context);
    expect(artifacts.map((a) => a.certificateId)).toEqual(["cert-1", "cert-2"]);
    expect(artifacts[0]).toMatchObject({
      certificateId: "cert-1",
      generation: 3,
      domains: ["a.example.com"],
      fingerprintSha256: "fp-1",
      certificatePem: "CERT",
      privateKeyPem: "KEY",
    });
  });

  it("sorts by certificateId then generation", () => {
    const mk = (
      id: string,
      generation: number,
    ): CertificateArtifactContext => ({
      certificate: { id, domains: [id], activeMaterialVersion: generation },
      binding: { enabled: true, desiredGeneration: generation },
      material: {
        certificatePem: "C",
        privateKeyPem: "K",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2027-01-01T00:00:00.000Z",
        fingerprintSha256: `fp-${id}-${generation}`,
      },
    });
    const artifacts = buildCertificateArtifacts([
      mk("b", 3),
      mk("a", 2),
      mk("a", 3),
    ]);
    expect(artifacts.map((a) => `${a.certificateId}:${a.generation}`)).toEqual([
      "a:2",
      "a:3",
      "b:3",
    ]);
  });
});

describe("filterCertificateArtifactsForBindings", () => {
  it("ships only the exact certificate generations referenced by materialized bindings", () => {
    const artifacts = [
      ...sampleArtifacts(),
      {
        ...sampleArtifacts()[0]!,
        certificateId: "cert-unused",
        fingerprintSha256: "fp-unused",
      },
      {
        ...sampleArtifacts()[0]!,
        generation: 2,
        fingerprintSha256: "fp-old",
      },
    ];
    expect(
      filterCertificateArtifactsForBindings(artifacts, sampleBindings()),
    ).toEqual(sampleArtifacts());
    expect(filterCertificateArtifactsForBindings(artifacts, [])).toEqual([]);
  });
});

describe("buildGenerationByCertificateId", () => {
  it("ignores disabled bindings so a node never looks managed without an artifact", () => {
    const context: CertificateArtifactContext[] = [
      {
        certificate: { id: "cert-1", domains: [], activeMaterialVersion: 3 },
        binding: { enabled: true, desiredGeneration: 3 },
      },
      {
        certificate: {
          id: "cert-disabled",
          domains: [],
          activeMaterialVersion: 5,
        },
        binding: { enabled: false, desiredGeneration: 5 },
      },
    ];
    const map = buildGenerationByCertificateId(context);
    expect(map.has("cert-disabled")).toBe(false);
    expect(map.get("cert-1")).toBe(3);
  });

  it("falls back to the binding's desired generation when there is no active material", () => {
    const context: CertificateArtifactContext[] = [
      {
        certificate: { id: "cert-1", domains: [], activeMaterialVersion: null },
        binding: { enabled: true, desiredGeneration: 2 },
      },
    ];
    expect(buildGenerationByCertificateId(context).get("cert-1")).toBe(2);
  });

  it("prefers the active material version when one exists", () => {
    const context: CertificateArtifactContext[] = [
      {
        certificate: { id: "cert-1", domains: [], activeMaterialVersion: 3 },
        binding: { enabled: true, desiredGeneration: 2 },
      },
    ];
    expect(buildGenerationByCertificateId(context).get("cert-1")).toBe(3);
  });
});

describe("decideCertificateDeployment", () => {
  const deployment = {
    certificateId: "cert-1",
    generation: 3,
    fingerprintSha256: "fp-1",
    installed: true,
    inUse: true,
  };
  const binding = { enabled: true, desiredGeneration: 3 };

  it("is active only when installed and in use", () => {
    expect(decideCertificateDeployment(deployment, binding, "fp-1")).toEqual({
      state: "active",
      generation: 3,
      fingerprintSha256: "fp-1",
      installedGeneration: 3,
      installedFingerprintSha256: "fp-1",
      appliedGeneration: 3,
      errorPhase: null,
      errorMessage: null,
    });
  });

  it("rejects the impossible inUse=true + installed=false combination", () => {
    expect(
      decideCertificateDeployment(
        { ...deployment, installed: false },
        binding,
        "fp-1",
      ),
    ).toBeNull();
  });

  it("is pending and clears applied state when a current deployment is not in use", () => {
    expect(
      decideCertificateDeployment(
        { ...deployment, inUse: false },
        binding,
        "fp-1",
      ),
    ).toEqual({
      state: "pending",
      generation: 3,
      fingerprintSha256: "fp-1",
      installedGeneration: 3,
      installedFingerprintSha256: "fp-1",
      appliedGeneration: null,
      errorPhase: null,
      errorMessage: null,
    });
  });

  it("is error and clears applied state when a current deployment reports an error", () => {
    expect(
      decideCertificateDeployment(
        {
          ...deployment,
          inUse: false,
          errorPhase: "install",
          errorMessage: "permission denied",
        },
        binding,
        "fp-1",
      ),
    ).toEqual({
      state: "error",
      generation: 3,
      fingerprintSha256: "fp-1",
      installedGeneration: 3,
      installedFingerprintSha256: "fp-1",
      appliedGeneration: null,
      errorPhase: "install",
      errorMessage: "permission denied",
    });
  });

  it("clears installed metadata when the agent reports material is not installed", () => {
    expect(
      decideCertificateDeployment(
        { ...deployment, installed: false, inUse: false },
        binding,
        "fp-1",
      ),
    ).toEqual({
      state: "pending",
      generation: 3,
      fingerprintSha256: "fp-1",
      installedGeneration: null,
      installedFingerprintSha256: null,
      appliedGeneration: null,
      errorPhase: null,
      errorMessage: null,
    });
  });

  it("records error metadata on a not-installed deployment", () => {
    expect(
      decideCertificateDeployment(
        {
          ...deployment,
          installed: false,
          inUse: false,
          errorPhase: "fetch",
          errorMessage: "download failed",
        },
        binding,
        "fp-1",
      ),
    ).toEqual({
      state: "error",
      generation: 3,
      fingerprintSha256: "fp-1",
      installedGeneration: null,
      installedFingerprintSha256: null,
      appliedGeneration: null,
      errorPhase: "fetch",
      errorMessage: "download failed",
    });
  });

  it("rejects a deployment for a disabled binding", () => {
    expect(
      decideCertificateDeployment(
        deployment,
        { ...binding, enabled: false },
        "fp-1",
      ),
    ).toBeNull();
  });

  it("rejects a stale generation without clearing prior state", () => {
    expect(
      decideCertificateDeployment(
        deployment,
        { ...binding, desiredGeneration: 4 },
        "fp-1",
      ),
    ).toBeNull();
  });

  it("rejects a mismatched fingerprint", () => {
    expect(
      decideCertificateDeployment(deployment, binding, "fp-other"),
    ).toBeNull();
  });

  it("rejects when no active certificate material exists to verify against", () => {
    expect(decideCertificateDeployment(deployment, binding, null)).toBeNull();
  });
});
