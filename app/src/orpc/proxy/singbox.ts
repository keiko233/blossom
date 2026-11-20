import { Configuration } from "@black-duty/sing-box-schema";
import type {
  AgentConfigV3Output,
  ManagedIntentRouteRule,
  ManagedPeerTlsBinding,
  ManagedPeerTrustArtifact,
  ManagedRuleSetArtifact,
  ManagedRuleSetBinding,
  ManagedSnapshotExtension,
  ManagedStageIntent,
} from "@blossom/contracts/agent-config-v3";
import { BUILTIN_DIRECT_OUTBOUND_TAG } from "@blossom/domain/managed-networking";
import { createHash } from "node:crypto";

import type { Node } from "@/db/proxy-schema";
import type { SingboxRouteRule } from "@/lib/routing-rules";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  protocolSupportsTls,
  withoutNodeTlsMaterial,
} from "@/orpc/proxy/sing-box-registry";

/**
 * Compiles a server's nodes into a single complete sing-box config. The agent
 * fetches this and applies it via process hot-reload, so the output is the
 * whole config, not a fragment. The result is validated against
 * `@black-duty/sing-box-schema`, so a malformed node surfaces here instead of
 * crashing the agent.
 *
 * `node.settings` is already a native sing-box inbound fragment (validated on
 * write); the compiler only injects the managed fields and wraps it. The agent
 * adds its own `api` service at runtime for connection-stream traffic, so the
 * base config deliberately carries no legacy `experimental.v2ray_api` hook.
 * `route` carries the server-scoped routing rules (`toSingboxRouteRules`),
 * empty when none are configured.
 */

export type SingboxConfig = Configuration;

export interface SingboxUser {
  /** Coded identifier for protocols keyed by `name`; absent for username-keyed. */
  name?: string;
  // Protocol-specific credential fields are merged in by the caller (password/uuid).
  [key: string]: unknown;
}

type Json = Record<string, unknown>;

/**
 * One node plus the entitlement-derived user entries to embed as the inbound's
 * `users` array. An entry whose `users` array is empty is dropped by the
 * compiler: a node with no currently-entitled subscriptions must not appear in
 * the running config at all, because sing-box treats an empty `users` array
 * differently across protocols — socks/http accept it (open proxy with no
 * authentication), while vless/naive/ss reject it or are unsafe with it. The
 * single rule "no users → no inbound" is the only safe behaviour, so callers
 * pass the pruned list and the compiler filters here.
 */
export interface NodeInbound {
  node: Node;
  users: SingboxUser[];
}

export interface CompileOptions {
  /** One entry per node to compile. The order is preserved in `inbounds`. */
  inbounds: NodeInbound[];
  /** Server-side routing rules in sing-box rule-action syntax; default none. */
  routeRules?: SingboxRouteRule[];
}

/**
 * Compiles an entire server's compiled inbound set. Inbounds with zero users
 * are dropped before assembly (see `NodeInbound`): only a node with at least
 * one currently-entitled subscription is materialised into the running config.
 * When the resulting `inbounds` is empty (server disabled, or all nodes have no
 * entitled users) a valid config with an empty `inbounds` array is returned.
 * The agent applies it and tears down every previous listener.
 */
export function compileServerConfig(options: CompileOptions): SingboxConfig {
  const { inbounds, routeRules = [] } = options;

  const compiled = inbounds
    .filter(({ users }) => users.length > 0)
    .map(({ node, users }) => buildInbound(node, users));

  const draft: Json = {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [{ tag: "google", type: "tls", server: "8.8.8.8" }],
    },
    inbounds: compiled,
    outbounds: [{ type: "direct", tag: "direct" }],
    // Server-scoped routing rules (reject only: the sole outbound is `direct`).
    route: { rules: routeRules, rule_set: [], final: "direct" },
  };

  // Validate the assembled config; throws on a malformed node.
  return Configuration.parse(draft);
}

function buildInbound(node: Node, users: SingboxUser[]): Json {
  const certificateId = node.certificateId;
  const usesManagedCertificate =
    certificateId !== null &&
    protocolSupportsTls(node.protocol) &&
    isNodeTlsEnabled(node.settings) &&
    !isNodeRealityEnabled(node.settings);
  // Sanitize at the compiler boundary unconditionally: node X.509 material is
  // never owned by a node. Old rows may still contain inline certificate/key
  // values that sing-box gives precedence over paths, even though current
  // create/update handlers strip those fields on write. The explicit SNI
  // column (`node.tlsServerName`) is the only source for `server_name`.
  const settings = withoutNodeTlsMaterial(node.settings) as Json;
  if (usesManagedCertificate) {
    const previousTls =
      typeof settings.tls === "object" &&
      settings.tls !== null &&
      !Array.isArray(settings.tls)
        ? (settings.tls as Json)
        : {};
    // V3: the base config never carries certificate material or its on-disk
    // location. The agent installs material from the V3 `certificateArtifacts`
    // itself and wires it into sing-box locally; the control plane only
    // preserves the non-material TLS options and the explicit server name.
    settings.tls = {
      ...previousTls,
      ...(node.tlsServerName ? { server_name: node.tlsServerName } : {}),
    };
  }
  // Managed fields override anything in the stored fragment.
  return {
    ...settings,
    type: node.protocol,
    tag: `node-${node.id}`,
    listen: "::",
    listen_port: node.listenPort,
    users,
  };
}

// --- V3 agent desired-state assembly ---------------------------------------
//
// Deterministic, dependency-free helpers that shape the V3 `/agent/config/v3`
// payload and its desired revision. Kept here (and pure) so the identity,
// sorting, and hashing rules are unit-testable without a database.

export interface ManagedTlsBinding {
  nodeId: string;
  inboundTag: string;
  certificateId: string;
  generation: number;
  serverName: string | null;
}

export interface CertificateArtifact {
  certificateId: string;
  generation: number;
  domains: string[];
  fingerprintSha256: string;
  notBefore: string;
  notAfter: string;
  certificatePem: string;
  privateKeyPem: string;
}

/** The revision-hashed subset of an artifact: metadata, never PEM bytes. */
export interface CertificateArtifactMetadata {
  certificateId: string;
  generation: number;
  domains: string[];
  fingerprintSha256: string;
  notBefore: string;
  notAfter: string;
}

/** A node whose inbound serves a managed certificate and needs binding/artifact state. */
export function isManagedTlsNode(node: Node): boolean {
  return (
    node.certificateId !== null &&
    protocolSupportsTls(node.protocol) &&
    isNodeTlsEnabled(node.settings) &&
    !isNodeRealityEnabled(node.settings)
  );
}

/**
 * Builds the deterministic `managedTlsBindings` list from a server's enabled
 * nodes. A node is included only when its certificate is bound to the server
 * (i.e. has a desired generation); nodes are emitted in id order.
 */
export function buildManagedTlsBindings(
  nodes: Node[],
  generationByCertificateId: ReadonlyMap<string, number>,
): ManagedTlsBinding[] {
  return nodes
    .filter(isManagedTlsNode)
    .filter((node) => generationByCertificateId.has(node.certificateId!))
    .map((node) => ({
      nodeId: node.id,
      inboundTag: `node-${node.id}`,
      certificateId: node.certificateId!,
      generation: generationByCertificateId.get(node.certificateId!)!,
      serverName: node.tlsServerName ?? null,
    }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

export interface CertificateArtifactContext {
  certificate: {
    id: string;
    domains: string[];
    activeMaterialVersion: number | null;
  };
  binding: {
    enabled: boolean;
    desiredGeneration: number;
  };
  material?: {
    certificatePem: string;
    privateKeyPem: string;
    notBefore: string;
    notAfter: string;
    fingerprintSha256: string;
  };
}

/**
 * Desired generation per certificate as seen by a server. Only enabled
 * bindings participate: a disabled binding must never make a node look
 * managed, otherwise the node would emit a `managedTlsBinding` with no
 * corresponding `certificateArtifact`. Falls back to the binding's desired
 * generation when the certificate has no active material yet.
 */
export function buildGenerationByCertificateId(
  context: CertificateArtifactContext[],
): Map<string, number> {
  const generationByCertificateId = new Map<string, number>();
  for (const { certificate, binding } of context) {
    if (!binding.enabled) {
      continue;
    }
    generationByCertificateId.set(
      certificate.id,
      certificate.activeMaterialVersion ?? binding.desiredGeneration,
    );
  }
  return generationByCertificateId;
}

/**
 * Builds the deterministic, deduplicated `certificateArtifacts` list from the
 * certificate/binding context. Only enabled bindings with active material emit
 * an artifact; one artifact per (certificateId, generation).
 */
export function buildCertificateArtifacts(
  context: CertificateArtifactContext[],
): CertificateArtifact[] {
  const seen = new Set<string>();
  const artifacts: CertificateArtifact[] = [];
  for (const { certificate, binding, material } of context) {
    if (
      !binding.enabled ||
      certificate.activeMaterialVersion === null ||
      !material
    ) {
      continue;
    }
    const key = `${certificate.id}:${certificate.activeMaterialVersion}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    artifacts.push({
      certificateId: certificate.id,
      generation: certificate.activeMaterialVersion,
      domains: [...certificate.domains],
      fingerprintSha256: material.fingerprintSha256,
      notBefore: material.notBefore,
      notAfter: material.notAfter,
      certificatePem: material.certificatePem,
      privateKeyPem: material.privateKeyPem,
    });
  }
  return artifacts.sort(
    (a, b) =>
      a.certificateId.localeCompare(b.certificateId) ||
      a.generation - b.generation,
  );
}

/**
 * Keep only material referenced by a materialized managed-TLS inbound. This is
 * both a correctness boundary (no phantom deployments for omitted inbounds)
 * and a secret-minimization boundary (never ship unrelated private keys).
 */
export function filterCertificateArtifactsForBindings(
  artifacts: CertificateArtifact[],
  bindings: ManagedTlsBinding[],
): CertificateArtifact[] {
  const referenced = new Set(
    bindings.map((binding) => `${binding.certificateId}:${binding.generation}`),
  );
  return artifacts.filter((artifact) =>
    referenced.has(`${artifact.certificateId}:${artifact.generation}`),
  );
}

/**
 * Deterministic, order-independent JSON serialization: object keys are sorted,
 * arrays keep their order. Used to turn the desired state into a canonical
 * revision that is stable across identical snapshots regardless of key order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
        .join(",")}}`;
    }
    default:
      return "null";
  }
}

function toArtifactMetadata(
  artifact: CertificateArtifact,
): CertificateArtifactMetadata {
  return {
    certificateId: artifact.certificateId,
    generation: artifact.generation,
    domains: artifact.domains,
    fingerprintSha256: artifact.fingerprintSha256,
    notBefore: artifact.notBefore,
    notAfter: artifact.notAfter,
  };
}

export interface ManagedPeerTrustArtifactMetadata {
  certificateId: string;
  generation: number;
  domains: string[];
  fingerprintSha256: string;
  notBefore: string;
  notAfter: string;
}

export interface ManagedRuleSetArtifactMetadata {
  ruleSetId: string;
  version: string;
  format: "binary";
  sha256: string;
  sizeBytes: number;
}

export interface ManagedSnapshotRevisionMetadata {
  schemaVersion: number;
  configVersionId: string;
  intentDigest: string;
  managedFingerprint: string;
  tlsBindings: ManagedPeerTlsBinding[];
  peerTrustArtifacts: ManagedPeerTrustArtifactMetadata[];
  ruleSetBindings: ManagedRuleSetBinding[];
  ruleSetArtifacts: ManagedRuleSetArtifactMetadata[];
}

function toPeerTrustArtifactMetadata(
  artifact: ManagedPeerTrustArtifact,
): ManagedPeerTrustArtifactMetadata {
  return {
    certificateId: artifact.certificateId,
    generation: artifact.generation,
    domains: [...artifact.domains],
    fingerprintSha256: artifact.fingerprintSha256,
    notBefore: artifact.notBefore,
    notAfter: artifact.notAfter,
  };
}

function toRuleSetArtifactMetadata(
  artifact: ManagedRuleSetArtifact,
): ManagedRuleSetArtifactMetadata {
  return {
    ruleSetId: artifact.ruleSetId,
    version: artifact.version,
    format: artifact.format,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  };
}

function toManagedSnapshotRevisionMetadata(
  managed: ManagedSnapshotExtension,
): ManagedSnapshotRevisionMetadata {
  return {
    schemaVersion: managed.schemaVersion,
    configVersionId: managed.configVersionId,
    intentDigest: managed.intentDigest,
    managedFingerprint: managed.managedFingerprint,
    tlsBindings: [...managed.tlsBindings].sort((a, b) =>
      a.bindingId.localeCompare(b.bindingId),
    ),
    peerTrustArtifacts: managed.peerTrustArtifacts
      .map(toPeerTrustArtifactMetadata)
      .sort(
        (a, b) =>
          a.certificateId.localeCompare(b.certificateId) ||
          a.generation - b.generation,
      ),
    ruleSetBindings: [...managed.ruleSetBindings].sort((a, b) =>
      a.runtimeTag.localeCompare(b.runtimeTag),
    ),
    ruleSetArtifacts: managed.ruleSetArtifacts
      .map(toRuleSetArtifactMetadata)
      .sort(
        (a, b) =>
          a.ruleSetId.localeCompare(b.ruleSetId) ||
          a.version.localeCompare(b.version),
      ),
  };
}

/**
 * sha256 of the canonical desired state: the compiled sing-box config, the
 * managed TLS bindings, the artifact metadata (fingerprint in place of PEM
 * bytes), the materialized node ids, and (when present) the single-unit
 * managed extension metadata. Omitting `managed` preserves the legacy hash
 * byte-for-byte. Never includes certificate_server acknowledgement state
 * (`appliedGeneration`, install/in-use timestamps) or any agent-reported data,
 * so an unchanged desired state yields an unchanged revision and a stale ack
 * cannot spuriously re-trigger a reload.
 */
export function computeDesiredRevision(
  config: SingboxConfig,
  bindings: ManagedTlsBinding[],
  artifacts: CertificateArtifact[],
  materializedNodeIds: string[],
  managed?: ManagedSnapshotExtension | null,
): string {
  const canonical = canonicalize({
    config,
    bindings,
    artifacts: artifacts.map(toArtifactMetadata),
    materializedNodeIds,
    ...(managed ? { managed: toManagedSnapshotRevisionMetadata(managed) } : {}),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Hashes the pinned stage intent before dynamic subscriber admission (`users`)
 * and zero-user pruning (`managed_config_version.intent_digest`).
 *
 * Includes structural subscriber ingress, peer inbounds and link admissions,
 * managed outbounds and peer trust references, routing policy, rule-set
 * references, and stage presence/removal expectations.
 */
export function computeManagedStageIntentDigest(
  intent: ManagedStageIntent,
): string {
  const canonical = canonicalize({
    schemaVersion: intent.schemaVersion,
    configVersionId: intent.configVersionId,
    serverId: intent.serverId,
    version: intent.version,
    subscriberInbounds: [...intent.subscriberInbounds].sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId),
    ),
    peerInbounds: [...intent.peerInbounds]
      .map((peer) => ({
        ...peer,
        admissions: [...peer.admissions].sort(
          (a, b) =>
            a.linkId.localeCompare(b.linkId) ||
            a.credentialGeneration - b.credentialGeneration,
        ),
      }))
      .sort((a, b) => a.inboundId.localeCompare(b.inboundId)),
    outbounds: [...intent.outbounds]
      .map((outbound) => ({
        ...outbound,
        trustedCertificates: [...outbound.trustedCertificates].sort(
          (a, b) =>
            a.certificateId.localeCompare(b.certificateId) ||
            a.generation - b.generation,
        ),
      }))
      .sort((a, b) => a.outboundId.localeCompare(b.outboundId)),
    routingPolicy: {
      finalOutboundTag: intent.routingPolicy.finalOutboundTag,
      rules: intent.routingPolicy.rules.map((rule) => ({
        ...rule,
        inboundTags: [...rule.inboundTags].sort(),
        domains: [...rule.domains].sort(),
        domainSuffixes: [...rule.domainSuffixes].sort(),
        domainKeywords: [...rule.domainKeywords].sort(),
        ipCidrs: [...rule.ipCidrs].sort(),
        ports: [...rule.ports].sort((a, b) => a - b),
        ruleSetTags: [...rule.ruleSetTags].sort(),
      })),
    },
    ruleSets: [...intent.ruleSets].sort((a, b) =>
      a.runtimeTag.localeCompare(b.runtimeTag),
    ),
    stageExpectations: {
      requiredRuntimeTags: [
        ...intent.stageExpectations.requiredRuntimeTags,
      ].sort(),
      removedRuntimeTags: [
        ...intent.stageExpectations.removedRuntimeTags,
      ].sort(),
    },
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Hashes the stage-equivalence managed fingerprint
 * (`managed_rollout_stage.managed_fingerprint`).
 *
 * Includes required presences and removals, peer inbounds with valid
 * admissions, managed outbounds, routing policy, and rule-set bindings.
 * Deliberately excludes dynamic subscriber admission (`users`), zero-user
 * subscriber pruning, and subscriber certificate renewals so a subscriber
 * entitlement change or certificate rotation can advance `desiredRevision`
 * while preserving stage equivalence.
 */
export function computeManagedStateFingerprint(
  intent: ManagedStageIntent,
): string {
  const canonical = canonicalize({
    schemaVersion: intent.schemaVersion,
    serverId: intent.serverId,
    peerInbounds: [...intent.peerInbounds]
      .filter((peer) => peer.admissions.length > 0)
      .map((peer) => ({
        inboundId: peer.inboundId,
        runtimeTag: peer.runtimeTag,
        protocol: peer.protocol,
        listenAddress: peer.listenAddress,
        listenPort: peer.listenPort,
        advertisedAddress: peer.advertisedAddress,
        advertisedPort: peer.advertisedPort,
        tlsServerName: peer.tlsServerName,
        certificateId: peer.certificateId,
        certificateGeneration: peer.certificateGeneration,
        certificateFingerprintSha256: peer.certificateFingerprintSha256,
        admissions: [...peer.admissions].sort(
          (a, b) =>
            a.linkId.localeCompare(b.linkId) ||
            a.credentialGeneration - b.credentialGeneration,
        ),
      }))
      .sort((a, b) => a.inboundId.localeCompare(b.inboundId)),
    outbounds: [...intent.outbounds]
      .map((outbound) => ({
        outboundId: outbound.outboundId,
        runtimeTag: outbound.runtimeTag,
        kind: outbound.kind,
        dialOptions: outbound.dialOptions,
        linkId: outbound.linkId,
        destinationServerId: outbound.destinationServerId,
        destinationInboundId: outbound.destinationInboundId,
        protocol: outbound.protocol,
        serverAddress: outbound.serverAddress,
        serverPort: outbound.serverPort,
        tlsServerName: outbound.tlsServerName,
        credentialGeneration: outbound.credentialGeneration,
        trustMode: outbound.trustMode,
        trustedCertificates: [...outbound.trustedCertificates].sort(
          (a, b) =>
            a.certificateId.localeCompare(b.certificateId) ||
            a.generation - b.generation,
        ),
      }))
      .sort((a, b) => a.outboundId.localeCompare(b.outboundId)),
    routingPolicy: {
      finalOutboundTag: intent.routingPolicy.finalOutboundTag,
      rules: intent.routingPolicy.rules.map((rule) => ({
        ruleId: rule.ruleId,
        inboundTags: [...rule.inboundTags].sort(),
        sniff: rule.sniff,
        resolveStrategy: rule.resolveStrategy,
        network: rule.network,
        domains: [...rule.domains].sort(),
        domainSuffixes: [...rule.domainSuffixes].sort(),
        domainKeywords: [...rule.domainKeywords].sort(),
        ipCidrs: [...rule.ipCidrs].sort(),
        ports: [...rule.ports].sort((a, b) => a - b),
        ruleSetTags: [...rule.ruleSetTags].sort(),
        action: rule.action,
        outboundTag: rule.outboundTag,
      })),
    },
    ruleSets: [...intent.ruleSets].sort((a, b) =>
      a.runtimeTag.localeCompare(b.runtimeTag),
    ),
    stageExpectations: {
      requiredRuntimeTags: [
        ...intent.stageExpectations.requiredRuntimeTags,
      ].sort(),
      removedRuntimeTags: [
        ...intent.stageExpectations.removedRuntimeTags,
      ].sort(),
    },
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Intersects each routing rule's `inboundTags` scope with the set of actually
 * materialized listener tags (after zero-user subscriber pruning and
 * zero-admission peer pruning) and drops rules with an empty intersection so
 * an omitted listener never turns a scoped rule into a global match.
 */
export function intersectManagedRouteRulesWithMaterializedInbounds(
  rules: readonly ManagedIntentRouteRule[],
  materializedInboundTags: ReadonlySet<string>,
): ManagedIntentRouteRule[] {
  const scoped: ManagedIntentRouteRule[] = [];
  for (const rule of rules) {
    const inboundTags = rule.inboundTags.filter((tag) =>
      materializedInboundTags.has(tag),
    );
    if (inboundTags.length === 0) {
      continue;
    }
    scoped.push({
      ...rule,
      inboundTags,
    });
  }
  return scoped;
}

export type ManagedMaterializationIssue =
  | { code: "missing_managed_extension" }
  | {
      code: "config_version_mismatch";
      expected: string;
      actual: string;
    }
  | {
      code: "intent_digest_mismatch";
      expected: string;
      actual: string;
    }
  | {
      code: "managed_fingerprint_mismatch";
      expected: string;
      actual: string;
    }
  | {
      code: "missing_required_runtime_tag";
      runtimeTag: string;
    }
  | {
      code: "present_removed_runtime_tag";
      runtimeTag: string;
    }
  | {
      code: "unreferenced_or_empty_route_scope";
      ruleIndex: number;
    }
  | {
      code: "unresolved_route_outbound";
      ruleIndex: number;
      outboundTag: string;
    }
  | {
      code: "missing_peer_tls_artifact";
      bindingId: string;
      certificateId: string;
      generation: number;
    }
  | {
      code: "missing_rule_set_artifact";
      runtimeTag: string;
      ruleSetId: string;
      version: string;
    };

export interface ManagedMaterializationValidationResult {
  ok: boolean;
  intentDigest: string;
  managedFingerprint: string;
  materializedRuntimeTags: string[];
  prunedZeroUserSubscriberTags: string[];
  issues: ManagedMaterializationIssue[];
}

/**
 * Validates a materialized V3 snapshot against its pinned `ManagedStageIntent`
 * before associating the full `desiredRevision` identifier with a rollout
 * stage.
 *
 * Zero-user subscriber inbounds (`node-<id>`) may be absent from
 * `singboxConfig.inbounds` and `materializedNodeIds` while their policy stays
 * staged in `intent`, whereas required peer inbounds, outbounds and rule-sets
 * must be materialized and every removed runtime tag must be absent.
 */
export function validateMaterializedSnapshotAgainstIntent(
  intent: ManagedStageIntent,
  snapshot: AgentConfigV3Output,
): ManagedMaterializationValidationResult {
  const intentDigest = computeManagedStageIntentDigest(intent);
  const managedFingerprint = computeManagedStateFingerprint(intent);
  const issues: ManagedMaterializationIssue[] = [];

  if (!snapshot.managed) {
    return {
      ok: false,
      intentDigest,
      managedFingerprint,
      materializedRuntimeTags: [],
      prunedZeroUserSubscriberTags: [],
      issues: [{ code: "missing_managed_extension" }],
    };
  }

  const managed = snapshot.managed;
  if (managed.configVersionId !== intent.configVersionId) {
    issues.push({
      code: "config_version_mismatch",
      expected: intent.configVersionId,
      actual: managed.configVersionId,
    });
  }
  if (managed.intentDigest !== intentDigest) {
    issues.push({
      code: "intent_digest_mismatch",
      expected: intentDigest,
      actual: managed.intentDigest,
    });
  }
  if (managed.managedFingerprint !== managedFingerprint) {
    issues.push({
      code: "managed_fingerprint_mismatch",
      expected: managedFingerprint,
      actual: managed.managedFingerprint,
    });
  }

  const rawConfig = snapshot.singboxConfig as Record<string, unknown>;
  const rawInbounds = Array.isArray(rawConfig.inbounds)
    ? (rawConfig.inbounds as Record<string, unknown>[])
    : [];
  const rawOutbounds = Array.isArray(rawConfig.outbounds)
    ? (rawConfig.outbounds as Record<string, unknown>[])
    : [];
  const rawRoute =
    typeof rawConfig.route === "object" &&
    rawConfig.route !== null &&
    !Array.isArray(rawConfig.route)
      ? (rawConfig.route as Record<string, unknown>)
      : {};
  const rawRuleSets = Array.isArray(rawRoute.rule_set)
    ? (rawRoute.rule_set as Record<string, unknown>[])
    : [];
  const rawRules = Array.isArray(rawRoute.rules)
    ? (rawRoute.rules as Record<string, unknown>[])
    : [];

  const inboundTags = new Set<string>();
  for (const inbound of rawInbounds) {
    if (typeof inbound.tag === "string" && inbound.tag.length > 0) {
      inboundTags.add(inbound.tag);
    }
  }
  const outboundTags = new Set<string>([BUILTIN_DIRECT_OUTBOUND_TAG]);
  for (const outbound of rawOutbounds) {
    if (typeof outbound.tag === "string" && outbound.tag.length > 0) {
      outboundTags.add(outbound.tag);
    }
  }
  const ruleSetTags = new Set<string>();
  for (const ruleSet of rawRuleSets) {
    if (typeof ruleSet.tag === "string" && ruleSet.tag.length > 0) {
      ruleSetTags.add(ruleSet.tag);
    }
  }
  for (const binding of managed.ruleSetBindings) {
    ruleSetTags.add(binding.runtimeTag);
  }

  const materializedRuntimeTags = [
    ...inboundTags,
    ...outboundTags,
    ...ruleSetTags,
  ].sort();
  const materializedSet = new Set(materializedRuntimeTags);

  const structuralSubscriberTags = new Set(
    intent.subscriberInbounds.map((inbound) => inbound.inboundTag),
  );
  const prunedZeroUserSubscriberTags = [...structuralSubscriberTags]
    .filter((tag) => !inboundTags.has(tag))
    .sort();

  for (const requiredTag of intent.stageExpectations.requiredRuntimeTags) {
    if (
      !materializedSet.has(requiredTag) &&
      !structuralSubscriberTags.has(requiredTag)
    ) {
      issues.push({
        code: "missing_required_runtime_tag",
        runtimeTag: requiredTag,
      });
    }
  }

  const allReferencedTags = new Set<string>([
    ...materializedSet,
    ...snapshot.managedTlsBindings.map((b) => b.inboundTag),
    ...managed.tlsBindings.map((b) => b.runtimeTag),
    ...managed.ruleSetBindings.map((b) => b.runtimeTag),
  ]);
  for (const removedTag of intent.stageExpectations.removedRuntimeTags) {
    if (allReferencedTags.has(removedTag)) {
      issues.push({
        code: "present_removed_runtime_tag",
        runtimeTag: removedTag,
      });
    }
  }

  for (let index = 0; index < rawRules.length; index += 1) {
    const rule = rawRules[index]!;
    if ("inbound" in rule) {
      const ruleInbounds = Array.isArray(rule.inbound)
        ? rule.inbound.filter((tag): tag is string => typeof tag === "string")
        : typeof rule.inbound === "string"
          ? [rule.inbound]
          : [];
      if (
        ruleInbounds.length === 0 ||
        ruleInbounds.some((tag) => !inboundTags.has(tag))
      ) {
        issues.push({
          code: "unreferenced_or_empty_route_scope",
          ruleIndex: index,
        });
      }
    }
    if (typeof rule.outbound === "string" && !outboundTags.has(rule.outbound)) {
      issues.push({
        code: "unresolved_route_outbound",
        ruleIndex: index,
        outboundTag: rule.outbound,
      });
    }
  }

  const keypairArtifactKeys = new Set(
    snapshot.certificateArtifacts.map(
      (a) => `${a.certificateId}:${a.generation}:${a.fingerprintSha256}`,
    ),
  );
  const peerTrustArtifactKeys = new Set(
    managed.peerTrustArtifacts.map(
      (a) => `${a.certificateId}:${a.generation}:${a.fingerprintSha256}`,
    ),
  );
  for (const binding of managed.tlsBindings) {
    const key = `${binding.certificateId}:${binding.generation}:${binding.fingerprintSha256}`;
    const hasArtifact =
      binding.direction === "inbound"
        ? keypairArtifactKeys.has(key)
        : peerTrustArtifactKeys.has(key);
    if (!hasArtifact) {
      issues.push({
        code: "missing_peer_tls_artifact",
        bindingId: binding.bindingId,
        certificateId: binding.certificateId,
        generation: binding.generation,
      });
    }
  }

  const ruleSetArtifactKeys = new Set(
    managed.ruleSetArtifacts.map(
      (a) =>
        `${a.ruleSetId}:${a.version}:${a.format}:${a.sha256}:${a.sizeBytes}`,
    ),
  );
  for (const binding of managed.ruleSetBindings) {
    const key = `${binding.ruleSetId}:${binding.version}:${binding.format}:${binding.sha256}:${binding.sizeBytes}`;
    if (!ruleSetArtifactKeys.has(key)) {
      issues.push({
        code: "missing_rule_set_artifact",
        runtimeTag: binding.runtimeTag,
        ruleSetId: binding.ruleSetId,
        version: binding.version,
      });
    }
  }

  return {
    ok: issues.length === 0,
    intentDigest,
    managedFingerprint,
    materializedRuntimeTags,
    prunedZeroUserSubscriberTags,
    issues,
  };
}

/**
 * Checks whether an authenticated agent report proves a rollout stage:
 * the reported revision sequence must be at or above the stage's minimum
 * sequence and carry the exact verified `managedFingerprint`.
 */
export function doesAppliedSnapshotProveStage(
  stage: {
    minRevisionSeq: number;
    managedFingerprint: string;
  },
  applied: {
    desiredRevisionSeq: number;
    managedFingerprint: string | null | undefined;
  },
): boolean {
  return (
    applied.desiredRevisionSeq >= stage.minRevisionSeq &&
    applied.managedFingerprint === stage.managedFingerprint
  );
}

export interface CertificateDeploymentDecision {
  /**
   * The binding state this accepted deployment resolves to:
   * - `active` only when the material is installed and in use,
   * - `error` when an explicitly reported, current deployment is not in use
   *   and carries error metadata,
   * - `pending` otherwise.
   */
  state: "active" | "error" | "pending";
  generation: number;
  fingerprintSha256: string;
  /** Set when installed, null when the agent reports the material is not installed. */
  installedGeneration: number | null;
  installedFingerprintSha256: string | null;
  /** Set only while the deployment is in use; null otherwise (cleared). */
  appliedGeneration: number | null;
  errorPhase: string | null;
  errorMessage: string | null;
}

/**
 * Pure acceptance + state-transition check for one heartbeat
 * `certificateDeployments` entry. A deployment is accepted only for an enabled
 * binding whose generation equals the desired generation and whose fingerprint
 * equals the active certificate material. Accepted deployments make the
 * binding truthful: `active`/`appliedGeneration` only while installed and in
 * use, `error` when a not-in-use deployment reports an error, otherwise
 * `pending` with applied state cleared; an `installed=false` report clears the
 * installed metadata. The impossible `inUse=true + installed=false` combo is
 * rejected outright. Stale or mismatched entries are rejected — and because
 * acceptance is the only path that writes, a missing entry can never falsely
 * clear a previously valid acknowledgement.
 */
export function decideCertificateDeployment(
  deployment: {
    certificateId: string;
    generation: number;
    fingerprintSha256: string;
    installed: boolean;
    inUse: boolean;
    errorPhase?: string;
    errorMessage?: string;
  },
  binding: { enabled: boolean; desiredGeneration: number },
  activeFingerprintSha256: string | null,
): CertificateDeploymentDecision | null {
  if (!binding.enabled) {
    return null;
  }
  if (deployment.generation !== binding.desiredGeneration) {
    return null;
  }
  if (deployment.fingerprintSha256 !== activeFingerprintSha256) {
    return null;
  }
  // A deployment cannot be in use before its material is installed; report the
  // contradiction by ignoring the entry rather than writing a false active.
  if (deployment.inUse && !deployment.installed) {
    return null;
  }

  const hasError =
    deployment.errorPhase !== undefined ||
    deployment.errorMessage !== undefined;
  return {
    state: deployment.inUse ? "active" : hasError ? "error" : "pending",
    generation: deployment.generation,
    fingerprintSha256: deployment.fingerprintSha256,
    installedGeneration: deployment.installed ? deployment.generation : null,
    installedFingerprintSha256: deployment.installed
      ? deployment.fingerprintSha256
      : null,
    appliedGeneration: deployment.inUse ? deployment.generation : null,
    errorPhase: deployment.errorPhase ?? null,
    errorMessage: deployment.errorMessage ?? null,
  };
}
