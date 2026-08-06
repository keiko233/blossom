import { Configuration } from "@black-duty/sing-box-schema";
import { createHash } from "node:crypto";

import type { Node } from "@/db/proxy-schema";
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
 * write); the compiler only injects the managed fields and wraps it. Two
 * forward-looking hooks:
 *  - `experimental.v2ray_api`: the stats/user API the agent uses to add users
 *    and report traffic.
 *  - `route`: an empty placeholder for the future rules module (server-side
 *    routing).
 */

export type SingboxConfig = Configuration;

export interface SingboxUser {
  /** Coded identifier for protocols keyed by `name`; absent for username-keyed. */
  name?: string;
  // Protocol-specific credential fields are merged in by the caller (password/uuid).
  [key: string]: unknown;
}

type Json = Record<string, unknown>;

const V2RAY_API_LISTEN = "127.0.0.1:8080";

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
  /** Enable the v2ray stats/user API used for traffic reporting. Default on. */
  enableV2rayApi?: boolean;
}

/**
 * Compiles an entire server's compiled inbound set. Inbounds with zero users
 * are dropped before assembly (see `NodeInbound`): only a node with at least
 * one currently-entitled subscription is materialised into the running config.
 * When the resulting `inbounds` is empty (server disabled, or all nodes have no
 * entitled users) a valid config with an empty `inbounds` array is returned —
 * the agent applies it, tears down every previous listener, and keeps the
 * `v2ray_api` experimental hook so a later entitlement change can re-enable
 * listeners without re-architecting the agent.
 *
 * `stats.inbounds` collects every inbound tag, `stats.users` deduplicates
 * every inbound user's `name` across the multi-inbound config: each coded name
 * already encodes the producing node, so a subscription appearing on several
 * nodes still produces distinct, accurate counters. Username-keyed protocols
 * (naive/socks/http) have no `name` at all and are invisible to v2ray_api user
 * stats — their traffic is not reported per-user, a known limitation.
 */
export function compileServerConfig(options: CompileOptions): SingboxConfig {
  const { inbounds, enableV2rayApi = true } = options;

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
    // Placeholder for the future rules module: server-side routing gets injected here.
    route: { rules: [], rule_set: [], final: "direct" },
  };

  if (enableV2rayApi) {
    draft.experimental = buildV2rayApi(compiled);
  }

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

function buildV2rayApi(compiled: Json[]): Json {
  const tags = compiled.map((inbound) => inbound.tag as string);
  const userSet = new Set<string>();
  for (const inbound of compiled) {
    const users = inbound.users as SingboxUser[] | undefined;
    if (!Array.isArray(users)) {
      continue;
    }
    for (const user of users) {
      if (typeof user.name === "string") {
        userSet.add(user.name);
      }
    }
  }
  return {
    v2ray_api: {
      listen: V2RAY_API_LISTEN,
      stats: {
        enabled: true,
        inbounds: tags,
        // Username-keyed protocols (naive/socks/http) have no `name` field, so
        // v2ray_api never sees a per-user counter for them — their traffic is
        // not reported per user. Accepted limitation, carried over from the
        // single-inbound design.
        users: [...userSet],
      },
    },
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

/**
 * sha256 of the canonical desired state: the compiled sing-box config, the
 * managed TLS bindings, the artifact metadata (fingerprint in place of PEM
 * bytes), and the materialized node ids. Never includes certificate_server
 * acknowledgement state (`appliedGeneration`, install/in-use timestamps) or any
 * agent-reported data, so an unchanged desired state yields an unchanged
 * revision and a stale ack cannot spuriously re-trigger a reload.
 */
export function computeDesiredRevision(
  config: SingboxConfig,
  bindings: ManagedTlsBinding[],
  artifacts: CertificateArtifact[],
  materializedNodeIds: string[],
): string {
  const canonical = canonicalize({
    config,
    bindings,
    artifacts: artifacts.map(toArtifactMetadata),
    materializedNodeIds,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
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
