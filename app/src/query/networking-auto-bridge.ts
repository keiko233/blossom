import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import {
  isPeerProtocol,
  managedRuntimeTag,
  peerProtocolCapability,
  type PeerNetwork,
  type PeerProtocol,
} from "@blossom/domain/managed-networking";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
import { db } from "@/db";
import {
  listenerClaim,
  managedOutbound,
  peerInbound,
  peerLink,
  peerLinkCredential,
  portForward,
} from "@/db/managed-network-schema";
import {
  certificateServer,
  managedCertificate,
  node,
  server,
} from "@/db/proxy-schema";
import { encryptManagedPeerCredential } from "@/lib/managed-credential-crypto";
import {
  peerInboundTlsRequired,
  validatePeerInboundSettings,
  type AutoBridgeInput,
  type AutoBridgeMode,
} from "@/lib/networking-schema";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  isNodeRealityEnabled,
  withoutNodeTlsMaterial,
} from "@/orpc/proxy/sing-box-registry";
import {
  conflictReason,
  createPeerLinkDraft,
  currentGenerationCte,
  executeRows,
  generationNow,
  jsonParam,
  numeric,
  peerSecret,
  type NetworkingWriteResult,
} from "@/query/networking-write";

/**
 * Automatic peer bridges (PR 4). One destination server is asked for either an
 * existing peer listener (`reuse_peer_inbound`), an isolated listener mirroring
 * an existing subscriber node (`bridge_existing_node`), or a freshly
 * provisioned peer listener (`auto_create_peer`). The sender side (link,
 * credential and outbound) is created by the same statement as the receiver,
 * so neon-http cannot leave a half-created bridge.
 *
 * Free-port selection is part of that statement: it scans from
 * `preferredPort ?? 20000` for a port absent from `listener_claim`, `node`,
 * `peer_inbound` and `port_forward` on the destination server. Port allocation
 * therefore observes the topology CAS instead of racing another draft.
 */

export const AUTO_BRIDGE_PORT_START = 20_000;
const MAX_PORT = 65_535;
const AUTO_BRIDGE_LISTEN_ADDRESS = "0.0.0.0";

/** First port at or above `start` not in `taken`, or null when exhausted. */
export function selectAutoBridgePort(
  start: number,
  taken: readonly number[],
): number | null {
  const normalized = Math.min(Math.max(Math.trunc(start), 1), MAX_PORT);
  const used = new Set(taken);
  for (let port = normalized; port <= MAX_PORT; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

function autoBridgeName(prefix: string, value: string): string {
  return `${prefix}${value}`.slice(0, 128);
}

/** Catch-all rules that make every source subscriber inbound forward to the bridge. */
export function fullForwardRoutingRules(
  linkId: string,
  outboundTag: string,
  sourceNodeIds: readonly string[],
): ManagedIntentRouteRule[] {
  return sourceNodeIds.map((nodeId) => ({
    ruleId: `auto-bridge-${linkId}-${nodeId}`.slice(0, 128),
    inboundTags: [`node-${nodeId}`],
    sniff: false,
    resolveStrategy: null,
    network: null,
    domains: [],
    domainSuffixes: [],
    domainKeywords: [],
    ipCidrs: [],
    ports: [],
    ruleSetTags: [],
    action: "route",
    outboundTag,
  }));
}

export interface AutoBridgeNodeContext {
  id: string;
  serverId: string;
  address: string | null;
  protocol: string;
  certificateId: string | null;
  tlsServerName: string | null;
  settings: Record<string, JsonValue>;
}

export interface AutoBridgeInboundContext {
  id: string;
  serverId: string;
  runtimeTag: string;
  protocol: PeerProtocol;
  listenPort: number;
  advertisedAddress: string;
  advertisedPort: number;
  network: PeerNetwork;
  certificateId: string | null;
  tlsServerName: string | null;
  settings: Record<string, JsonValue>;
}

export interface AutoBridgeCertificateContext {
  id: string;
  domains: string[];
}

export interface AutoBridgePlanContext {
  destinationAddress: string;
  existingInbound?: AutoBridgeInboundContext;
  existingNode?: AutoBridgeNodeContext;
  /** The certificate that will actually be bound, after explicit/auto selection. */
  certificate?: AutoBridgeCertificateContext;
}

export type AutoBridgePlan =
  | {
      ok: true;
      mode: "reuse_peer_inbound";
      inbound: AutoBridgeInboundContext;
    }
  | {
      ok: true;
      mode: "auto_create_peer" | "bridge_existing_node";
      protocol: PeerProtocol;
      settings: Record<string, JsonValue>;
      network: PeerNetwork;
      certificateId: string | null;
      tlsServerName: string | null;
      sourceNodeId: string | null;
      advertisedAddress: string;
    }
  | { ok: false; reason: string; message?: string };

function failed(reason: string, message: string): AutoBridgePlan {
  return { ok: false, reason, message };
}

/**
 * Pure decision step: validates the selected mode's inputs and resolves the
 * receiver protocol profile. The database wrapper performs the certificate
 * lookup first and then feeds the resolved certificate in here, which keeps the
 * decisions unit-testable without PostgreSQL.
 */
export function planAutoBridge(
  input: AutoBridgeInput,
  context: AutoBridgePlanContext,
): AutoBridgePlan {
  if (input.sourceServerId === input.destinationServerId) {
    return failed("invalid_link", "An auto bridge must target another server");
  }

  if (input.mode === "reuse_peer_inbound") {
    const inbound = context.existingInbound;
    if (!inbound || inbound.serverId !== input.destinationServerId) {
      return failed(
        "not_found",
        "The peer inbound to reuse is not on the destination server",
      );
    }
    return { ok: true, mode: "reuse_peer_inbound", inbound };
  }

  if (input.mode === "bridge_existing_node") {
    const existing = context.existingNode;
    if (!existing || existing.serverId !== input.destinationServerId) {
      return failed(
        "not_found",
        "The subscriber node to mirror is not on the destination server",
      );
    }
    if (!isPeerProtocol(existing.protocol)) {
      return failed(
        "unsupported",
        `${existing.protocol} cannot be used for an inter-server peer listener`,
      );
    }
    const settings = validatePeerInboundSettings(
      existing.protocol,
      withoutNodeTlsMaterial(existing.settings) as Record<string, JsonValue>,
    );
    if (!settings.ok) {
      return failed("invalid_settings", settings.message);
    }
    const certificateId = existing.certificateId;
    const tlsServerName = existing.tlsServerName;
    const tlsRequired =
      peerInboundTlsRequired(existing.protocol, settings.settings) &&
      !isNodeRealityEnabled(settings.settings);
    if (tlsRequired) {
      if (!certificateId || !context.certificate) {
        return failed(
          "certificate_not_found",
          "The mirrored node needs an active certificate bound to the destination server",
        );
      }
      if (!tlsServerName) {
        return failed(
          "invalid_settings",
          "The mirrored node has no server name for its TLS listener",
        );
      }
    }
    return {
      ok: true,
      mode: "bridge_existing_node",
      protocol: existing.protocol,
      settings: settings.settings,
      network: peerProtocolCapability(existing.protocol).defaultNetwork,
      certificateId: tlsRequired ? certificateId : null,
      tlsServerName: tlsRequired ? tlsServerName : null,
      sourceNodeId: existing.id,
      advertisedAddress: existing.address ?? context.destinationAddress,
    };
  }

  const protocol = input.protocol;
  const capability = peerProtocolCapability(protocol);
  const supplied = { ...input.settings } as Record<string, JsonValue>;
  if (protocol === "shadowsocks" && !("method" in supplied)) {
    supplied.method = "2022-blake3-aes-128-gcm";
  }
  const settings = validatePeerInboundSettings(
    protocol,
    withoutNodeTlsMaterial(supplied) as Record<string, JsonValue>,
  );
  if (!settings.ok) {
    return failed("invalid_settings", settings.message);
  }
  const certificateId = input.certificateId ?? context.certificate?.id ?? null;
  const tlsServerName =
    input.tlsServerName ?? context.certificate?.domains[0] ?? null;
  const tlsRequired =
    peerInboundTlsRequired(protocol, settings.settings) &&
    !isNodeRealityEnabled(settings.settings);
  if (tlsRequired) {
    if (!certificateId || !context.certificate) {
      return failed(
        "certificate_not_found",
        "TLS is required but no active certificate is bound to the destination server",
      );
    }
    if (!tlsServerName) {
      return failed(
        "invalid_settings",
        "TLS is required but no server name is available for peers to dial",
      );
    }
  }
  return {
    ok: true,
    mode: "auto_create_peer",
    protocol,
    settings: settings.settings,
    network: input.network ?? capability.defaultNetwork,
    certificateId: tlsRequired ? certificateId : null,
    tlsServerName,
    sourceNodeId: null,
    advertisedAddress: context.destinationAddress,
  };
}

interface ServerRow {
  id: string;
  name: string;
  address: string;
}

async function loadServers(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, ServerRow>> {
  const rows = await database
    .select({ id: server.id, name: server.name, address: server.address })
    .from(server)
    .where(inArray(server.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadDestinationCertificate(
  database: Database,
  input: AutoBridgeInput,
  existingNode: AutoBridgeNodeContext | undefined,
): Promise<AutoBridgeCertificateContext | null> {
  const explicitId =
    input.mode === "auto_create_peer"
      ? input.certificateId
      : existingNode?.certificateId;
  if (explicitId) {
    const [row] = await database
      .select({
        id: managedCertificate.id,
        domains: managedCertificate.domains,
      })
      .from(managedCertificate)
      .where(
        and(
          eq(managedCertificate.id, explicitId),
          eq(managedCertificate.state, "active"),
          sql`${managedCertificate.activeMaterialVersion} IS NOT NULL`,
        ),
      );
    return row ? { id: row.id, domains: row.domains } : null;
  }
  if (input.mode !== "auto_create_peer") return null;

  const [row] = await database
    .select({ id: managedCertificate.id, domains: managedCertificate.domains })
    .from(managedCertificate)
    .innerJoin(
      certificateServer,
      eq(certificateServer.certificateId, managedCertificate.id),
    )
    .where(
      and(
        eq(certificateServer.serverId, input.destinationServerId),
        eq(certificateServer.enabled, true),
        eq(certificateServer.state, "active"),
        eq(managedCertificate.state, "active"),
        sql`${managedCertificate.activeMaterialVersion} IS NOT NULL`,
      ),
    )
    .orderBy(managedCertificate.createdAt)
    .limit(1);
  return row ? { id: row.id, domains: row.domains } : null;
}

async function loadSourceNodeIds(
  database: Database,
  serverId: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: node.id })
    .from(node)
    .where(eq(node.serverId, serverId))
    .orderBy(node.id);
  return rows.map((row) => row.id);
}

export interface AutoBridgeSummary {
  mode: AutoBridgeMode;
  sourceServerId: string;
  destinationServerId: string;
  peerInboundId: string;
  peerInboundTag: string;
  listenPort: number;
  linkId: string;
  outboundId: string;
  outboundTag: string;
  credentialGeneration: number;
  /** Ready-to-save full-forward rules; null unless `fullForward` was requested. */
  fullForward: {
    finalOutboundTag: "direct";
    rules: ManagedIntentRouteRule[];
  } | null;
}

function fullForward(
  input: AutoBridgeInput,
  linkId: string,
  outboundTag: string,
  sourceNodeIds: readonly string[],
): AutoBridgeSummary["fullForward"] {
  if (!input.fullForward) return null;
  return {
    finalOutboundTag: "direct",
    rules: fullForwardRoutingRules(linkId, outboundTag, sourceNodeIds),
  };
}

async function bridgeResult(
  database: Database,
  input: AutoBridgeInput,
  plan: Extract<AutoBridgePlan, { ok: true }>,
  result: {
    generation: number;
    peerInboundId: string;
    peerInboundTag: string;
    listenPort: number;
    linkId: string;
    outboundId: string;
    outboundTag: string;
  },
): Promise<NetworkingWriteResult<AutoBridgeSummary>> {
  const sourceNodeIds = input.fullForward
    ? await loadSourceNodeIds(database, input.sourceServerId)
    : [];
  return {
    ok: true,
    ...result,
    mode: plan.mode,
    sourceServerId: input.sourceServerId,
    destinationServerId: input.destinationServerId,
    credentialGeneration: 1,
    fullForward: fullForward(
      input,
      result.linkId,
      result.outboundTag,
      sourceNodeIds,
    ),
  };
}

/**
 * Create (or reuse) the destination peer receiver and the source link/outbound
 * in one topology-fenced statement. `reuse_peer_inbound` deliberately delegates
 * to the existing link writer, which already atomicizes link + credential +
 * outbound.
 */
export async function autoBridgeServersDraft(
  input: AutoBridgeInput,
  database: Database = db,
): Promise<NetworkingWriteResult<AutoBridgeSummary>> {
  if (input.sourceServerId === input.destinationServerId) {
    return {
      ok: false,
      reason: "invalid_link",
      message: "An auto bridge must target another server",
    };
  }
  const servers = await loadServers(database, [
    input.sourceServerId,
    input.destinationServerId,
  ]);
  const source = servers.get(input.sourceServerId);
  const destination = servers.get(input.destinationServerId);
  if (!source || !destination) {
    return {
      ok: false,
      reason: "not_found",
      message: "Source or destination server not found",
    };
  }
  const destinationName = destination.name;
  const sourceName = source.name;

  if (input.mode === "reuse_peer_inbound") {
    const inboundId = input.existingPeerInboundId;
    if (!inboundId) {
      return {
        ok: false,
        reason: "not_found",
        message: "Select the existing peer inbound to reuse",
      };
    }
    const [inbound] = await database
      .select()
      .from(peerInbound)
      .where(eq(peerInbound.id, inboundId));
    if (!inbound || inbound.serverId !== input.destinationServerId) {
      return {
        ok: false,
        reason: "not_found",
        message: "The peer inbound to reuse is not on the destination server",
      };
    }
    const plan = planAutoBridge(input, {
      destinationAddress: destination.address,
      existingInbound: {
        id: inbound.id,
        serverId: inbound.serverId,
        runtimeTag: inbound.runtimeTag,
        protocol: inbound.protocol,
        listenPort: inbound.listenPort,
        advertisedAddress: inbound.advertisedAddress,
        advertisedPort: inbound.advertisedPort,
        network: inbound.network,
        certificateId: inbound.certificateId,
        tlsServerName: inbound.tlsServerName,
        settings: inbound.settings,
      },
    });
    if (!plan.ok) {
      return { ok: false, reason: plan.reason, message: plan.message };
    }
    if (plan.mode !== "reuse_peer_inbound") {
      return {
        ok: false,
        reason: "unsupported",
        message: "Unexpected auto-bridge plan",
      };
    }
    const link = await createPeerLinkDraft(
      {
        sourceServerId: input.sourceServerId,
        destinationInboundId: inbound.id,
        name: autoBridgeName("Auto bridge to ", destinationName),
        expectedTopologyGeneration: input.expectedTopologyGeneration,
      },
      database,
    );
    if (!link.ok) {
      return { ok: false, reason: link.reason, message: link.message };
    }
    return bridgeResult(database, input, plan, {
      generation: link.generation,
      peerInboundId: inbound.id,
      peerInboundTag: inbound.runtimeTag,
      listenPort: inbound.listenPort,
      linkId: link.linkId,
      outboundId: link.outboundId,
      outboundTag: link.outboundTag,
    });
  }

  let existingNode: AutoBridgeNodeContext | undefined;
  if (input.mode === "bridge_existing_node") {
    const nodeId = input.existingNodeId;
    if (!nodeId) {
      return {
        ok: false,
        reason: "not_found",
        message: "Select the subscriber node to mirror",
      };
    }
    const [row] = await database.select().from(node).where(eq(node.id, nodeId));
    if (!row || row.serverId !== input.destinationServerId) {
      return {
        ok: false,
        reason: "not_found",
        message:
          "The subscriber node to mirror is not on the destination server",
      };
    }
    existingNode = {
      id: row.id,
      serverId: row.serverId,
      address: row.address,
      protocol: row.protocol,
      certificateId: row.certificateId,
      tlsServerName: row.tlsServerName,
      settings: row.settings,
    };
  }

  const certificate = await loadDestinationCertificate(
    database,
    input,
    existingNode,
  );
  const plan = planAutoBridge(input, {
    destinationAddress: destination.address,
    existingNode,
    certificate: certificate ?? undefined,
  });
  if (!plan.ok) {
    return { ok: false, reason: plan.reason, message: plan.message };
  }
  if (plan.mode === "reuse_peer_inbound") {
    return {
      ok: false,
      reason: "unsupported",
      message: "Unexpected auto-bridge plan",
    };
  }

  const id = randomUUID();
  const linkId = randomUUID();
  const outboundId = randomUUID();
  const inboundTag = managedRuntimeTag("peer_inbound", id);
  const outboundTag = managedRuntimeTag("peer_link", outboundId);
  const preferredPort = input.preferredPort ?? AUTO_BRIDGE_PORT_START;
  const peerName = autoBridgeName("Auto bridge from ", sourceName);
  const linkName = autoBridgeName("Auto bridge to ", destinationName);

  let ciphertext: string;
  try {
    ciphertext = encryptManagedPeerCredential(
      linkId,
      1,
      peerSecret(plan.protocol),
    );
  } catch {
    return {
      ok: false,
      reason: "credential_key_unavailable",
      message:
        "Peer credentials cannot be encrypted until CERTIFICATE_MASTER_KEY is configured",
    };
  }

  const rows = await executeRows<{
    id: string;
    runtime_tag: string;
    listen_port: number;
    link_id: string;
    outbound_id: string;
    outbound_tag: string;
    generation: number;
  }>(
    database,
    sql`
      WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
      destination AS (
        SELECT * FROM ${server}
        WHERE ${server.id} = ${input.destinationServerId}::text
          AND ${server.id} <> ${input.sourceServerId}::text
      ),
      free_port AS (
        SELECT picked.port
        FROM destination d
        CROSS JOIN topology_cas
        CROSS JOIN LATERAL (
          SELECT candidate AS port
          FROM generate_series(
            ${Math.min(Math.max(preferredPort, 1), MAX_PORT)}::integer,
            ${MAX_PORT}::integer
          ) AS candidate
          WHERE NOT EXISTS (
            SELECT 1 FROM ${listenerClaim}
            WHERE ${listenerClaim.serverId} = d.id
              AND ${listenerClaim.port} = candidate
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${node}
            WHERE ${node.serverId} = d.id
              AND ${node.listenPort} = candidate
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${peerInbound}
            WHERE ${peerInbound.serverId} = d.id
              AND ${peerInbound.listenPort} = candidate
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${portForward}
            WHERE ${portForward.serverId} = d.id
              AND ${portForward.listenPort} = candidate
          )
          ORDER BY candidate
          LIMIT 1
        ) picked
      ),
      peer AS (
        INSERT INTO ${peerInbound} (
          id, server_id, name, runtime_tag, protocol,
          listen_address, listen_port,
          advertised_address, advertised_port,
          network, settings, tls_server_name, certificate_id, source_node_id
        )
        SELECT ${id}::text,
               d.id,
               ${peerName}::text,
               ${inboundTag}::text,
               ${plan.protocol}::text,
               ${AUTO_BRIDGE_LISTEN_ADDRESS}::text,
               free_port.port,
               ${plan.advertisedAddress}::text,
               free_port.port,
               ${plan.network}::text,
               ${jsonParam(plan.settings)},
               ${plan.tlsServerName}::text,
               ${plan.certificateId}::text,
               ${plan.sourceNodeId}::text
        FROM free_port
        CROSS JOIN destination d
        RETURNING *
      ),
      link AS (
        INSERT INTO ${peerLink} (
          id, source_server_id, destination_inbound_id
        )
        SELECT ${linkId}::text,
               ${input.sourceServerId}::text,
               peer.id
        FROM peer
        RETURNING *
      ),
      outbound AS (
        INSERT INTO ${managedOutbound} (
          id, server_id, kind, name, runtime_tag, link_id
        )
        SELECT ${outboundId}::text,
               link.source_server_id,
               'peer_link',
               ${linkName}::text,
               ${outboundTag}::text,
               link.id
        FROM link
        RETURNING *
      ),
      credential AS (
        INSERT INTO ${peerLinkCredential} (
          link_id, generation, state, credential_ciphertext
        )
        SELECT link.id, 1, 'active', ${ciphertext}::text
        FROM link
        RETURNING link_id
      )
      SELECT peer.id,
             peer.runtime_tag,
             peer.listen_port,
             link.id AS link_id,
             outbound.id AS outbound_id,
             outbound.runtime_tag AS outbound_tag,
             topology_cas.generation
      FROM peer
      CROSS JOIN link
      CROSS JOIN outbound
      CROSS JOIN credential
      CROSS JOIN topology_cas
    `,
  );

  if (!rows[0]) {
    if ((await generationNow(database)) !== input.expectedTopologyGeneration) {
      return conflictReason(database);
    }
    return {
      ok: false,
      reason: "port_exhausted",
      message: `No free port at or above ${preferredPort} remains on the destination server`,
    };
  }
  return bridgeResult(database, input, plan, {
    generation: numeric(rows[0].generation),
    peerInboundId: String(rows[0].id),
    peerInboundTag: String(rows[0].runtime_tag),
    listenPort: numeric(rows[0].listen_port),
    linkId: String(rows[0].link_id),
    outboundId: String(rows[0].outbound_id),
    outboundTag: String(rows[0].outbound_tag),
  });
}
