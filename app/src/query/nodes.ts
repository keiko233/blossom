import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
  certificateMaterial,
  certificateServer,
  managedCertificate,
  node,
  server,
} from "@/db/proxy-schema";
import {
  certificateCoversDomain,
  isCertificateCurrentlyUsable,
} from "@/lib/certificate-domain";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createNodeSchema,
  nodeIdSchema,
  parseNodeSettings,
  updateNodeSchema,
} from "@/orpc/proxy/schema";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  protocolSupportsTls,
  withoutManagedCertificateTlsFields,
} from "@/orpc/proxy/sing-box-registry";

/** TanStack Query key for the admin node list. */
export const NODES_QUERY_KEY = ["admin", "nodes"] as const;

/**
 * Node as served to the admin list. Includes the owning server's security-
 * relevant summary (id, name, address, enabled) and the resolved public
 * endpoint address (= node.address ?? server.address). Never carries an agent
 * token hash — the token lives on the server now.
 */
export interface NodeListItem {
  id: string;
  name: string;
  remark: string | null;
  tags: string[];
  enabled: boolean;
  serverId: string;
  address: string | null;
  resolvedAddress: string;
  listenPort: number;
  protocol: string;
  certificateId: string | null;
  tlsServerName: string | null;
  settings: Record<string, unknown>;
  serverSummary: {
    id: string;
    name: string;
    address: string;
    enabled: boolean;
    agentTokenPrefix: string;
    lastSeenAt: Date | null;
    heartbeatIntervalSeconds: number;
    runtimeState: string;
    configState: string;
    appliedRevision: string | null;
    activeNodeIds: string[];
    lastErrorMessage: string | null;
    lastErrorNodeId: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Node as returned from `getNode` for the edit page. Carries the raw override
 * (which may be null when the node falls back to its server's address) plus
 * the owning server's summary so the form can show the fallback inline.
 */
export interface NodeDetail extends Omit<NodeListItem, "serverSummary"> {
  serverSummary: NodeListItem["serverSummary"] & {
    remark: string | null;
    enabled: boolean;
  };
}

function resolveAddress(
  nodeRow: typeof node.$inferSelect,
  serverRow: {
    address: string;
  },
): string {
  return nodeRow.address ?? serverRow.address;
}

export const listNodes = createServerFn({ method: "GET" }).handler(async () => {
  await ensureAdmin();
  const rows = await db
    .select({ node, server })
    .from(node)
    .innerJoin(server, eq(server.id, node.serverId))
    .orderBy(desc(node.createdAt));

  return rows.map(({ node: n, server: s }) => ({
    id: n.id,
    name: n.name,
    remark: n.remark,
    tags: n.tags,
    enabled: n.enabled,
    serverId: n.serverId,
    address: n.address,
    resolvedAddress: resolveAddress(n, s),
    listenPort: n.listenPort,
    protocol: n.protocol,
    certificateId: n.certificateId,
    tlsServerName: n.tlsServerName,
    settings: n.settings,
    serverSummary: {
      id: s.id,
      name: s.name,
      address: s.address,
      enabled: s.enabled,
      agentTokenPrefix: s.agentTokenPrefix,
      lastSeenAt: s.lastSeenAt,
      heartbeatIntervalSeconds: s.heartbeatIntervalSeconds,
      runtimeState: s.runtimeState,
      configState: s.configState,
      appliedRevision: s.appliedRevision,
      activeNodeIds: s.activeNodeIds,
      lastErrorMessage: s.lastErrorMessage,
      lastErrorNodeId: s.lastErrorNodeId,
    },
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  })) satisfies NodeListItem[];
});

export const getNode = createServerFn({ method: "GET" })
  .validator(nodeIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db
      .select({ node, server })
      .from(node)
      .innerJoin(server, eq(server.id, node.serverId))
      .where(eq(node.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    const { node: n, server: s } = row;
    return {
      id: n.id,
      name: n.name,
      remark: n.remark,
      tags: n.tags,
      enabled: n.enabled,
      serverId: n.serverId,
      address: n.address,
      resolvedAddress: resolveAddress(n, s),
      listenPort: n.listenPort,
      protocol: n.protocol,
      certificateId: n.certificateId,
      tlsServerName: n.tlsServerName,
      settings: n.settings,
      serverSummary: {
        id: s.id,
        name: s.name,
        remark: s.remark,
        address: s.address,
        enabled: s.enabled,
        agentTokenPrefix: s.agentTokenPrefix,
        lastSeenAt: s.lastSeenAt,
        heartbeatIntervalSeconds: s.heartbeatIntervalSeconds,
        runtimeState: s.runtimeState,
        configState: s.configState,
        appliedRevision: s.appliedRevision,
        activeNodeIds: s.activeNodeIds,
        lastErrorMessage: s.lastErrorMessage,
        lastErrorNodeId: s.lastErrorNodeId,
      },
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    } satisfies NodeDetail;
  });

export const createNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    await validateManagedCertificateSelection(
      data.serverId,
      data.certificateId,
      data.tlsServerName,
      data.enabled,
      data.protocol,
      data.settings,
    );

    // No agent token is minted here — the owning server holds it.
    const [row] = await db
      .insert(node)
      .values({
        id: randomUUID(),
        name: data.name,
        remark: data.remark,
        tags: data.tags,
        enabled: data.enabled,
        serverId: data.serverId,
        // `null` IS a valid override ("use server.address"); only `undefined`
        // should fall back to the schema default (empty {}).
        address: data.address ?? null,
        listenPort: data.listenPort,
        protocol: data.protocol,
        certificateId: data.certificateId ?? null,
        tlsServerName: data.tlsServerName ?? null,
        // Strictly re-validate the fragment against the sing-box schema for this protocol.
        settings: parseNodeSettings(
          data.protocol,
          sanitizeCertificateSettings(
            data.protocol,
            data.settings,
            data.certificateId,
          ),
        ),
      })
      .returning();

    return { node: row };
  });

export const updateNode = createServerFn({ method: "POST" })
  .validator(updateNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const {
      id,
      protocol,
      settings,
      address,
      certificateId,
      tlsServerName,
      ...rest
    } = data;

    const [existingNode] = await db.select().from(node).where(eq(node.id, id));
    if (!existingNode) throw new Error("Not found");
    const effectiveCertificateId =
      certificateId === undefined ? existingNode.certificateId : certificateId;
    const effectiveProtocol = protocol ?? existingNode.protocol;
    const effectiveSettings = settings ?? existingNode.settings;
    await validateManagedCertificateSelection(
      data.serverId ?? existingNode.serverId,
      effectiveCertificateId,
      tlsServerName === undefined ? existingNode.tlsServerName : tlsServerName,
      data.enabled ?? existingNode.enabled,
      effectiveProtocol,
      effectiveSettings,
    );

    // Validating settings needs the effective protocol (may be unchanged on edit).
    let settingsUpdate:
      | Record<string, never>
      | { settings: ReturnType<typeof parseNodeSettings> } = {};
    if (
      settings !== undefined ||
      (certificateId !== undefined && Boolean(effectiveCertificateId))
    ) {
      settingsUpdate = {
        settings: parseNodeSettings(
          effectiveProtocol,
          sanitizeCertificateSettings(
            effectiveProtocol,
            effectiveSettings,
            effectiveCertificateId,
          ),
        ),
      };
    }

    // `undefined` => leave address alone; `null` => explicitly drop override and
    // fall back to server.address; string => set override.
    const addressUpdate =
      address === undefined
        ? {}
        : { address: address === null ? null : address };

    const [row] = await db
      .update(node)
      .set({
        ...rest,
        ...(protocol ? { protocol } : {}),
        ...(certificateId !== undefined ? { certificateId } : {}),
        ...(tlsServerName !== undefined ? { tlsServerName } : {}),
        ...settingsUpdate,
        ...addressUpdate,
      })
      .where(eq(node.id, id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

function sanitizeCertificateSettings(
  protocol: string,
  settings: Record<string, unknown>,
  certificateId: string | null | undefined,
): Record<string, unknown> {
  if (!protocolSupportsTls(protocol) || !isNodeTlsEnabled(settings)) {
    return settings;
  }
  return certificateId
    ? withoutManagedCertificateTlsFields(settings)
    : settings;
}

async function validateManagedCertificateSelection(
  serverId: string,
  certificateId: string | null | undefined,
  tlsServerName: string | null | undefined,
  enabled: boolean,
  protocol: string,
  settings: Record<string, unknown>,
): Promise<void> {
  if (!certificateId) return;
  if (!protocolSupportsTls(protocol)) {
    throw new Error("This protocol does not support TLS certificates");
  }
  if (!isNodeTlsEnabled(settings)) {
    throw new Error(
      "TLS must be enabled before selecting a managed certificate",
    );
  }
  if (isNodeRealityEnabled(settings)) {
    throw new Error("Reality cannot be combined with a managed certificate");
  }
  const [bound] = await db
    .select({
      certificate: managedCertificate,
      materialId: certificateMaterial.id,
    })
    .from(certificateServer)
    .innerJoin(
      managedCertificate,
      eq(managedCertificate.id, certificateServer.certificateId),
    )
    .leftJoin(
      certificateMaterial,
      and(
        eq(certificateMaterial.certificateId, managedCertificate.id),
        eq(
          certificateMaterial.version,
          managedCertificate.activeMaterialVersion,
        ),
      ),
    )
    .where(
      and(
        eq(certificateServer.certificateId, certificateId),
        eq(certificateServer.serverId, serverId),
        eq(certificateServer.enabled, true),
      ),
    );
  if (!bound)
    throw new Error("Certificate is not bound to the selected server");
  if (
    !tlsServerName ||
    !certificateCoversDomain(bound.certificate.domains, tlsServerName)
  ) {
    throw new Error("TLS server name is not covered by the certificate");
  }
  // The agent installs certificate actions before validating and applying the
  // sing-box config returned in the same poll. A pending server binding is
  // therefore usable as long as the control plane has valid active material.
  if (
    enabled &&
    !isCertificateCurrentlyUsable(bound.certificate, bound.materialId !== null)
  ) {
    throw new Error("An enabled node requires a valid issued certificate");
  }
}

export const deleteNode = createServerFn({ method: "POST" })
  .validator(nodeIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.delete(node).where(eq(node.id, data.id)).returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });
