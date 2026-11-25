import { Configuration } from "@black-duty/sing-box-schema";
import type {
  ManagedIntentOutbound,
  ManagedIntentPeerInbound,
  ManagedIntentRouteRule,
  ManagedPeerTlsBinding,
  ManagedPeerTrustArtifact,
  ManagedProbeBinding,
  ManagedRuleSetArtifact,
  ManagedRuleSetBinding,
  ManagedSnapshotExtension,
  ManagedStageIntent,
} from "@blossom/contracts/agent-config-v3";
import {
  deriveManagedProbeBindings,
  formatManagedPeerTlsBindingId,
  MANAGED_SNAPSHOT_SCHEMA_VERSION,
} from "@blossom/contracts/agent-config-v3";
import { encodePeerLinkIdentity } from "@blossom/domain/link-identity";
import { BUILTIN_DIRECT_OUTBOUND_TAG } from "@blossom/domain/managed-networking";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  ManagedCompileError,
  type ManagedCompileErrorCode,
} from "@/lib/managed-compile-error";
import type { SingboxRouteRule } from "@/lib/routing-rules";

import {
  BOOTSTRAP_DNS_TAG,
  canonicalize,
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
  intersectManagedRouteRulesWithMaterializedInbounds,
  type CertificateArtifact,
  type SingboxConfig,
  type SingboxUser,
} from "./singbox";

export {
  ManagedCompileError,
  ManagedNetworkingRequiresV2Error,
} from "@/lib/managed-compile-error";
export type { ManagedCompileErrorCode } from "@/lib/managed-compile-error";

/** Keys one decrypted peer credential by link and generation. */
export function managedPeerCredentialKey(
  linkId: string,
  generation: number,
): string {
  return `${linkId}:${generation}`;
}

export interface ManagedPeerTlsMaterial {
  inbound: {
    binding: ManagedPeerTlsBinding;
    artifact: CertificateArtifact;
  }[];
  outboundTrust: {
    binding: ManagedPeerTlsBinding;
    artifact: ManagedPeerTrustArtifact;
  }[];
}

export interface CompileManagedServerConfigInput {
  intent: ManagedStageIntent;
  /** Subscriber config compiled from live nodes and current entitlements. */
  subscriberConfig: SingboxConfig;
  /** Legacy global server reject rules, applied only to subscriber inbounds. */
  legacyRouteRules?: SingboxRouteRule[];
  /** Immutable binary SRS artifacts referenced by the intent. */
  ruleSetArtifacts: ManagedRuleSetArtifact[];
  /** Agent-scoped receiver identity and sender public trust material. */
  tlsMaterial: ManagedPeerTlsMaterial;
  /** Plaintext peer credentials keyed by `managedPeerCredentialKey`. */
  peerCredentials: ReadonlyMap<string, string>;
  /** Test seam only; production compiles use the wall clock. */
  now?: Date;
}

export interface CompileManagedServerConfigResult {
  config: SingboxConfig;
  extension: ManagedSnapshotExtension;
  intentDigest: string;
  managedFingerprint: string;
  /** Local link-to-tag mapping duplicated into the extension for the agent. */
  probeBindings: ManagedProbeBinding[];
  /** Peer receiver certificates that must also be staged by the agent. */
  peerCertificateArtifacts: CertificateArtifact[];
  /** Peer inbound tags omitted because no admission is currently valid. */
  prunedPeerInboundTags: string[];
  /** Inbound tags present in the materialized config, used for route scopes. */
  materializedInboundTags: string[];
  /** Immutable assets actually embedded in the snapshot. */
  embeddedRuleSetBindings: ManagedRuleSetBinding[];
}

type Json = Record<string, unknown>;

const LEGACY_RULE_SET_PLACEHOLDER_ROOT = "/blossom-managed/rule-sets";

function fail(code: ManagedCompileErrorCode, message: string): never {
  throw new ManagedCompileError(code, message);
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIpAddress(value: string): boolean {
  return isIP(value) !== 0;
}

function peerCredential(
  credentials: ReadonlyMap<string, string>,
  linkId: string,
  generation: number,
  where: string,
): string {
  const value = credentials.get(managedPeerCredentialKey(linkId, generation));
  if (value === undefined || value.length === 0) {
    fail(
      "missing_peer_credential",
      `peer credential ${linkId}:${generation} is not available for ${where}`,
    );
  }
  return value;
}

function peerUser(
  protocol: string,
  linkId: string,
  generation: number,
  credential: string,
): SingboxUser {
  const name = encodePeerLinkIdentity(linkId, generation);
  return protocol === "vless" || protocol === "vmess"
    ? { name, uuid: credential }
    : { name, ["password"]: credential };
}

function buildPeerInbound(
  peer: ManagedIntentPeerInbound,
  credentials: ReadonlyMap<string, string>,
): Json | null {
  if (peer.admissions.length === 0) {
    return null;
  }
  const users = [...peer.admissions]
    .sort(
      (a, b) =>
        a.linkId.localeCompare(b.linkId) ||
        a.credentialGeneration - b.credentialGeneration,
    )
    .map((admission) =>
      peerUser(
        peer.protocol,
        admission.linkId,
        admission.credentialGeneration,
        peerCredential(
          credentials,
          admission.linkId,
          admission.credentialGeneration,
          `peer inbound ${peer.inboundId}`,
        ),
      ),
    );
  return {
    type: peer.protocol,
    tag: peer.runtimeTag,
    listen: peer.listenAddress,
    listen_port: peer.listenPort,
    users,
    tls: {
      enabled: true,
      server_name: peer.tlsServerName,
    },
  };
}

function buildManagedOutbound(
  outbound: ManagedIntentOutbound,
  credentials: ReadonlyMap<string, string>,
): Json {
  if (outbound.kind === "direct_profile") {
    return {
      ...outbound.dialOptions,
      type: "direct",
      tag: outbound.runtimeTag,
    };
  }
  if (
    outbound.linkId === null ||
    outbound.protocol === null ||
    outbound.serverAddress === null ||
    outbound.serverPort === null ||
    outbound.tlsServerName === null ||
    outbound.credentialGeneration === null
  ) {
    fail(
      "managed_intent_invalid",
      `peer outbound ${outbound.outboundId} is missing its endpoint fields`,
    );
  }
  const credential = peerCredential(
    credentials,
    outbound.linkId,
    outbound.credentialGeneration,
    `peer outbound ${outbound.outboundId}`,
  );
  const tls: Json = {
    enabled: true,
    server_name: outbound.tlsServerName,
  };
  const base: Json = {
    type: outbound.protocol,
    tag: outbound.runtimeTag,
    server: outbound.serverAddress,
    server_port: outbound.serverPort,
    tls,
  };
  if (outbound.protocol === "trojan") {
    base["password"] = credential;
  } else {
    base.uuid = credential;
  }
  // A peer hostname must resolve through direct egress, never through the
  // link being commissioned. IP literals need no resolver.
  if (!isIpAddress(outbound.serverAddress)) {
    base.domain_resolver = BOOTSTRAP_DNS_TAG;
  }
  return base;
}

function ruleMatch(
  rule: ManagedIntentRouteRule,
  includeNetwork: boolean,
): Json {
  const match: Json = {};
  if (includeNetwork && rule.network !== null) {
    match.network = rule.network;
  }
  if (rule.domains.length > 0) match.domain = [...rule.domains];
  if (rule.domainSuffixes.length > 0) {
    match.domain_suffix = [...rule.domainSuffixes];
  }
  if (rule.domainKeywords.length > 0) {
    match.domain_keyword = [...rule.domainKeywords];
  }
  if (rule.ipCidrs.length > 0) match.ip_cidr = [...rule.ipCidrs];
  if (rule.ports.length > 0) match.port = [...rule.ports];
  if (rule.ruleSetTags.length > 0) match.rule_set = [...rule.ruleSetTags];
  return match;
}

function actionScope(tags: string[]): Json {
  return { inbound: tags };
}

function compileManagedRouteRule(
  rule: ManagedIntentRouteRule,
  materializedInboundTags: ReadonlySet<string>,
  outboundTags: ReadonlySet<string>,
): Json[] {
  const inboundTags = rule.inboundTags.filter((tag) =>
    materializedInboundTags.has(tag),
  );
  // A rule scoped only to an omitted listener must disappear, otherwise an
  // empty scope would become a global match.
  if (inboundTags.length === 0) {
    return [];
  }

  const actions: Json[] = [];
  if (rule.sniff) {
    actions.push({
      ...actionScope(inboundTags),
      ...(rule.network === null ? {} : { network: rule.network }),
      action: "sniff",
    });
  }
  if (rule.resolveStrategy !== null) {
    actions.push({
      ...actionScope(inboundTags),
      ...(rule.network === null ? {} : { network: rule.network }),
      action: "resolve",
      strategy: rule.resolveStrategy,
    });
  }

  if (rule.action === "reject") {
    actions.push({
      ...actionScope(inboundTags),
      ...ruleMatch(rule, true),
      action: "reject",
    });
    return actions;
  }

  const outboundTag = rule.outboundTag;
  if (outboundTag === null || !outboundTags.has(outboundTag)) {
    fail(
      "unknown_route_outbound",
      `route rule ${rule.ruleId} targets unknown outbound ${outboundTag ?? "<null>"}`,
    );
  }
  const peerTarget = outboundTag.startsWith("peer-out-");
  if (peerTarget) {
    if (rule.network === "udp") {
      fail(
        "unsupported_peer_network",
        `route rule ${rule.ruleId} routes UDP through TCP-only peer outbound ${outboundTag}`,
      );
    }
    actions.push({
      ...actionScope(inboundTags),
      ...ruleMatch(rule, false),
      network: "tcp",
      action: "route",
      outbound: outboundTag,
    });
    // A catch-all peer route must not let UDP/QUIC fall through to a later
    // global rule. The reject is ingress-scoped and uses the same match.
    if (rule.network === null) {
      actions.push({
        ...actionScope(inboundTags),
        ...ruleMatch(rule, false),
        network: "udp",
        action: "reject",
      });
    }
    return actions;
  }
  actions.push({
    ...actionScope(inboundTags),
    ...ruleMatch(rule, true),
    action: "route",
    outbound: outboundTag,
  });
  return actions;
}

function compileLegacyPrelude(
  legacyRouteRules: readonly SingboxRouteRule[],
  subscriberInboundTags: readonly string[],
): Json[] {
  if (subscriberInboundTags.length === 0) {
    return [];
  }
  return legacyRouteRules.map((rule) => ({
    ...rule,
    inbound: [...subscriberInboundTags],
  }));
}

function verifyRuleSetArtifacts(
  intent: ManagedStageIntent,
  artifacts: readonly ManagedRuleSetArtifact[],
): {
  bindings: ManagedRuleSetBinding[];
  artifacts: ManagedRuleSetArtifact[];
  rawSizes: { ruleSetId: string; rawBytes: number }[];
} {
  const byKey = new Map(
    artifacts.map((artifact) => [
      `${artifact.ruleSetId}:${artifact.version}`,
      artifact,
    ]),
  );
  const bindings: ManagedRuleSetBinding[] = [];
  const selected: ManagedRuleSetArtifact[] = [];
  const rawSizes: { ruleSetId: string; rawBytes: number }[] = [];
  for (const binding of [...intent.ruleSets].sort((a, b) =>
    a.runtimeTag.localeCompare(b.runtimeTag),
  )) {
    const artifact = byKey.get(`${binding.ruleSetId}:${binding.version}`);
    if (!artifact) {
      fail(
        "missing_rule_set_artifact",
        `rule-set artifact ${binding.ruleSetId}:${binding.version} is missing`,
      );
    }
    if (
      artifact.format !== binding.format ||
      artifact.sha256 !== binding.sha256 ||
      artifact.sizeBytes !== binding.sizeBytes
    ) {
      fail(
        "invalid_rule_set_artifact",
        `rule-set artifact ${binding.ruleSetId}:${binding.version} does not match its pinned binding`,
      );
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(artifact.contentBase64, "base64");
    } catch {
      fail(
        "invalid_rule_set_artifact",
        `rule-set artifact ${binding.ruleSetId}:${binding.version} has invalid base64 content`,
      );
    }
    const digest = createHash("sha256").update(decoded).digest("hex");
    if (decoded.length !== artifact.sizeBytes || digest !== artifact.sha256) {
      fail(
        "invalid_rule_set_artifact",
        `rule-set artifact ${binding.ruleSetId}:${binding.version} fails its digest or size check`,
      );
    }
    bindings.push(binding);
    selected.push(artifact);
    rawSizes.push({
      ruleSetId: artifact.ruleSetId,
      rawBytes: artifact.sizeBytes,
    });
  }
  return { bindings, artifacts: selected, rawSizes };
}

function ensureRuleSetEntries(
  config: Json,
  bindings: readonly ManagedRuleSetBinding[],
): void {
  const route = isObject(config.route) ? config.route : {};
  const entries = Array.isArray(route.rule_set)
    ? (route.rule_set as Json[])
    : [];
  const existing = new Map(
    entries
      .filter((entry) => typeof entry.tag === "string")
      .map((entry) => [entry.tag as string, entry]),
  );
  const ruleSet = bindings.map((binding) => {
    const current = existing.get(binding.runtimeTag);
    if (current?.format !== undefined && current.format !== binding.format) {
      fail(
        "invalid_rule_set_artifact",
        `route.rule_set ${binding.runtimeTag} format does not match its binding`,
      );
    }
    return {
      ...current,
      tag: binding.runtimeTag,
      type: "local",
      format: binding.format,
      // Placeholder only: the agent strips every control-plane path and
      // injects its own validated local `.srs` path before `sing-box check`.
      path: `${LEGACY_RULE_SET_PLACEHOLDER_ROOT}/${binding.ruleSetId}-${binding.version}.srs`,
    };
  });
  config.route = { ...route, rule_set: ruleSet };
}

function ensureManagedTlsBindings(
  intent: ManagedStageIntent,
  tlsMaterial: ManagedPeerTlsMaterial,
  now: Date,
): {
  bindings: ManagedPeerTlsBinding[];
  peerTrustArtifacts: ManagedPeerTrustArtifact[];
  peerCertificateArtifacts: CertificateArtifact[];
} {
  const bindings: ManagedPeerTlsBinding[] = [];
  const trustArtifacts = new Map<string, ManagedPeerTrustArtifact>();
  const receiverArtifacts = new Map<string, CertificateArtifact>();

  for (const peer of [...intent.peerInbounds].sort((a, b) =>
    a.inboundId.localeCompare(b.inboundId),
  )) {
    if (
      peer.admissions.length === 0 ||
      peer.certificateId === null ||
      peer.certificateGeneration === null
    ) {
      continue;
    }
    const matching = tlsMaterial.inbound.filter(
      (entry) =>
        entry.binding.direction === "inbound" &&
        entry.binding.ownerId === peer.inboundId &&
        entry.binding.certificateId === peer.certificateId &&
        entry.binding.generation === peer.certificateGeneration,
    );
    if (matching.length !== 1) {
      fail(
        "missing_peer_tls_artifact",
        `peer inbound ${peer.inboundId} requires exactly one receiver certificate artifact`,
      );
    }
    const entry = matching[0]!;
    const expectedId = formatManagedPeerTlsBindingId(entry.binding);
    if (entry.binding.bindingId !== expectedId) {
      fail(
        "managed_intent_invalid",
        `peer TLS binding ${entry.binding.bindingId} is not canonically identified`,
      );
    }
    if (
      entry.artifact.fingerprintSha256 !== peer.certificateFingerprintSha256 ||
      entry.artifact.certificateId !== peer.certificateId ||
      entry.artifact.generation !== peer.certificateGeneration
    ) {
      fail(
        "missing_peer_tls_artifact",
        `peer inbound ${peer.inboundId} certificate artifact does not match the pinned fingerprint`,
      );
    }
    assertCertificateUsable(
      entry.artifact,
      `peer inbound ${peer.inboundId}`,
      now,
    );
    bindings.push(entry.binding);
    receiverArtifacts.set(
      `${entry.artifact.certificateId}:${entry.artifact.generation}`,
      entry.artifact,
    );
  }

  for (const outbound of [...intent.outbounds].sort((a, b) =>
    a.outboundId.localeCompare(b.outboundId),
  )) {
    if (
      outbound.kind !== "peer_link" ||
      outbound.trustMode !== "managed_certificate"
    ) {
      continue;
    }
    for (const trust of [...outbound.trustedCertificates].sort(
      (a, b) =>
        a.certificateId.localeCompare(b.certificateId) ||
        a.generation - b.generation,
    )) {
      const matching = tlsMaterial.outboundTrust.filter(
        (entry) =>
          entry.binding.direction === "outbound" &&
          entry.binding.ownerId === outbound.outboundId &&
          entry.binding.certificateId === trust.certificateId &&
          entry.binding.generation === trust.generation,
      );
      if (matching.length !== 1) {
        fail(
          "missing_peer_tls_artifact",
          `peer outbound ${outbound.outboundId} requires a public trust artifact for ${trust.certificateId}:${trust.generation}`,
        );
      }
      const entry = matching[0]!;
      const expectedId = formatManagedPeerTlsBindingId(entry.binding);
      if (entry.binding.bindingId !== expectedId) {
        fail(
          "managed_intent_invalid",
          `peer TLS binding ${entry.binding.bindingId} is not canonically identified`,
        );
      }
      if (
        entry.artifact.fingerprintSha256 !== trust.fingerprintSha256 ||
        entry.artifact.certificateId !== trust.certificateId ||
        entry.artifact.generation !== trust.generation
      ) {
        fail(
          "missing_peer_tls_artifact",
          `peer outbound ${outbound.outboundId} trust artifact does not match the pinned fingerprint`,
        );
      }
      assertCertificateUsable(
        entry.artifact,
        `peer outbound ${outbound.outboundId}`,
        now,
      );
      bindings.push(entry.binding);
      trustArtifacts.set(
        `${entry.artifact.certificateId}:${entry.artifact.generation}`,
        entry.artifact,
      );
    }
  }

  return {
    bindings: bindings.sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
    peerTrustArtifacts: [...trustArtifacts.values()].sort(
      (a, b) =>
        a.certificateId.localeCompare(b.certificateId) ||
        a.generation - b.generation,
    ),
    peerCertificateArtifacts: [...receiverArtifacts.values()].sort(
      (a, b) =>
        a.certificateId.localeCompare(b.certificateId) ||
        a.generation - b.generation,
    ),
  };
}

function assertCertificateUsable(
  artifact: {
    certificateId: string;
    generation: number;
    notBefore: string;
    notAfter: string;
  },
  where: string,
  now: Date,
): void {
  const notBefore = Date.parse(artifact.notBefore);
  const notAfter = Date.parse(artifact.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    fail(
      "missing_peer_tls_artifact",
      `${where} certificate ${artifact.certificateId}:${artifact.generation} has invalid validity bounds`,
    );
  }
  if (notBefore > now.getTime() || notAfter <= now.getTime()) {
    fail(
      "missing_peer_tls_artifact",
      `${where} certificate ${artifact.certificateId}:${artifact.generation} is not currently valid`,
    );
  }
}

/**
 * Compiles the managed single-unit extension on top of the live subscriber
 * config. The frozen intent supplies peer structure, policy and artifact
 * references; live DB rows supply subscriber users/certificates and peer
 * credential generations. Deterministic ordering keeps the desiredRevision
 * stable across equivalent inputs.
 */
export function compileManagedServerConfig(
  input: CompileManagedServerConfigInput,
): CompileManagedServerConfigResult {
  const now = input.now ?? new Date();
  const intent = input.intent;
  const intentDigest = computeManagedStageIntentDigest(intent);
  const managedFingerprint = computeManagedStateFingerprint(intent);
  let probeBindings: ManagedProbeBinding[];
  try {
    probeBindings = deriveManagedProbeBindings(intent);
  } catch (error) {
    fail(
      "managed_intent_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  const ruleSets = verifyRuleSetArtifacts(intent, input.ruleSetArtifacts);
  const tls = ensureManagedTlsBindings(intent, input.tlsMaterial, now);

  const config = structuredClone(input.subscriberConfig) as unknown as Json;
  const inbounds = Array.isArray(config.inbounds)
    ? (config.inbounds as Json[])
    : [];
  const subscriberInboundTags = inbounds
    .map((inbound) => inbound.tag)
    .filter((tag): tag is string => typeof tag === "string");

  const outbounds = Array.isArray(config.outbounds)
    ? (config.outbounds as Json[])
    : [];
  const existingOutboundTags = new Set<string>([
    BUILTIN_DIRECT_OUTBOUND_TAG,
    ...outbounds
      .map((outbound) => outbound.tag)
      .filter((tag): tag is string => typeof tag === "string"),
  ]);
  const managedOutbounds = [...intent.outbounds]
    .sort((a, b) => a.outboundId.localeCompare(b.outboundId))
    .map((outbound) => buildManagedOutbound(outbound, input.peerCredentials));
  for (const outbound of managedOutbounds) {
    const tag = outbound.tag as string;
    if (existingOutboundTags.has(tag)) {
      fail(
        "managed_intent_invalid",
        `managed outbound tag ${tag} collides with an existing outbound`,
      );
    }
    existingOutboundTags.add(tag);
    outbounds.push(outbound);
  }
  config.outbounds = outbounds;

  const peerInbounds: Json[] = [];
  const peerInboundTags = new Set<string>();
  const prunedPeerInboundTags: string[] = [];
  for (const peer of [...intent.peerInbounds].sort((a, b) =>
    a.inboundId.localeCompare(b.inboundId),
  )) {
    const built = buildPeerInbound(peer, input.peerCredentials);
    if (!built) {
      prunedPeerInboundTags.push(peer.runtimeTag);
      continue;
    }
    if (
      subscriberInboundTags.includes(peer.runtimeTag) ||
      peerInboundTags.has(peer.runtimeTag)
    ) {
      fail(
        "managed_intent_invalid",
        `peer inbound tag ${peer.runtimeTag} is duplicated`,
      );
    }
    peerInboundTags.add(peer.runtimeTag);
    peerInbounds.push(built);
  }
  config.inbounds = [...inbounds, ...peerInbounds];

  const materializedInboundTags = new Set<string>([
    ...subscriberInboundTags,
    ...peerInboundTags,
  ]);

  const finalOutboundTag = intent.routingPolicy.finalOutboundTag;
  if (!existingOutboundTags.has(finalOutboundTag)) {
    fail(
      "unknown_final_outbound",
      `routing final outbound ${finalOutboundTag} is not materialized`,
    );
  }
  if (finalOutboundTag.startsWith("peer-out-")) {
    fail(
      "unsupported_final_outbound",
      "the routing final outbound cannot be a TCP-only peer link",
    );
  }

  const routeRules = [
    ...compileLegacyPrelude(
      input.legacyRouteRules ?? [],
      subscriberInboundTags,
    ),
    ...intersectManagedRouteRulesWithMaterializedInbounds(
      intent.routingPolicy.rules,
      materializedInboundTags,
    ).flatMap((rule) =>
      compileManagedRouteRule(
        rule,
        materializedInboundTags,
        existingOutboundTags,
      ),
    ),
  ];
  if (peerInboundTags.size > 0) {
    routeRules.push({
      inbound: [...peerInboundTags],
      action: "reject",
    });
  }

  const route = isObject(config.route) ? config.route : {};
  config.route = {
    ...route,
    rules: routeRules,
    rule_set: [],
    final: finalOutboundTag,
  };
  ensureRuleSetEntries(config, ruleSets.bindings);

  let parsed: SingboxConfig;
  try {
    parsed = Configuration.parse(config) as SingboxConfig;
  } catch (error) {
    fail(
      "snapshot_config_invalid",
      `managed sing-box config failed validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const extension: ManagedSnapshotExtension = {
    schemaVersion: MANAGED_SNAPSHOT_SCHEMA_VERSION,
    configVersionId: intent.configVersionId,
    intentDigest,
    managedFingerprint,
    tlsBindings: tls.bindings,
    peerTrustArtifacts: tls.peerTrustArtifacts,
    ruleSetBindings: ruleSets.bindings,
    ruleSetArtifacts: ruleSets.artifacts,
    probeBindings,
  };

  return {
    config: parsed,
    extension,
    intentDigest,
    managedFingerprint,
    probeBindings,
    peerCertificateArtifacts: tls.peerCertificateArtifacts,
    prunedPeerInboundTags,
    materializedInboundTags: [...materializedInboundTags].sort(),
    embeddedRuleSetBindings: ruleSets.bindings,
  };
}

/**
 * Serializes the complete V3 document and applies the activation-preview
 * budget. Every live compile also passes through the wire cap in
 * `assertManagedOutputBudget`; preview code should call this separately with
 * the same document it will show and activate.
 */
export function evaluateManagedOutputBudget(
  document: unknown,
  stage: "activation_preview" | "live_compile",
  ruleSets: readonly { ruleSetId: string; rawBytes: number }[],
): {
  ok: boolean;
  serializedBytes: number;
  violations: { code: string; actualBytes: number; limitBytes: number }[];
} {
  const serializedBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  const violations: {
    code: string;
    actualBytes: number;
    limitBytes: number;
  }[] = [];
  let aggregate = 0;
  for (const ruleSet of ruleSets) {
    aggregate += ruleSet.rawBytes;
    if (ruleSet.rawBytes > 512 * 1024) {
      violations.push({
        code: "rule_set_asset_too_large",
        actualBytes: ruleSet.rawBytes,
        limitBytes: 512 * 1024,
      });
    }
  }
  if (aggregate > 2 * 1024 * 1024) {
    violations.push({
      code: "rule_set_aggregate_too_large",
      actualBytes: aggregate,
      limitBytes: 2 * 1024 * 1024,
    });
  }
  if (stage === "activation_preview" && serializedBytes > 6 * 1024 * 1024) {
    violations.push({
      code: "preview_budget_exceeded",
      actualBytes: serializedBytes,
      limitBytes: 6 * 1024 * 1024,
    });
  }
  if (serializedBytes > 8 * 1024 * 1024) {
    violations.push({
      code: "wire_cap_exceeded",
      actualBytes: serializedBytes,
      limitBytes: 8 * 1024 * 1024,
    });
  }
  return {
    ok: violations.length === 0,
    serializedBytes,
    violations,
  };
}

/** Enforces the live wire cap for a fully assembled V3 document. */
export function assertManagedOutputBudget(
  document: unknown,
  ruleSets: readonly { ruleSetId: string; rawBytes: number }[],
): void {
  const budget = evaluateManagedOutputBudget(
    document,
    "live_compile",
    ruleSets,
  );
  const first = budget.violations[0];
  if (!first) {
    return;
  }
  throw new ManagedCompileError(
    first.code as ManagedCompileErrorCode,
    `compiled managed snapshot is ${first.actualBytes} bytes and violates ${first.code} (limit ${first.limitBytes})`,
  );
}

/**
 * Canonical metadata for a subscriber's structural settings. Intended for
 * frozen-intent writers (Task 08/09); the compiler deliberately does not
 * compare live settings with the intent, so a later subscriber-only revision
 * can advance `desiredRevision` while preserving stage equivalence.
 */
export function computeManagedSubscriberSettingsDigest(node: {
  id: string;
  protocol: string;
  listenPort: number;
  certificateId: string | null;
  tlsServerName: string | null;
  settings: Record<string, unknown>;
}): string {
  const canonical = canonicalize({
    protocol: node.protocol,
    listenPort: node.listenPort,
    certificateId: node.certificateId,
    tlsServerName: node.tlsServerName,
    settings: node.settings,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Test/downstream seam: merge peer receiver artifacts into the legacy list. */
export function mergePeerCertificateArtifacts(
  subscriberArtifacts: readonly CertificateArtifact[],
  peerArtifacts: readonly CertificateArtifact[],
): CertificateArtifact[] {
  const seen = new Set<string>();
  const result: CertificateArtifact[] = [];
  for (const artifact of [...subscriberArtifacts, ...peerArtifacts]) {
    const key = `${artifact.certificateId}:${artifact.generation}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(artifact);
  }
  return result.sort(
    (a, b) =>
      a.certificateId.localeCompare(b.certificateId) ||
      a.generation - b.generation,
  );
}
