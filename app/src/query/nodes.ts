import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
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
import { supportsInteractiveTransactions } from "@/lib/env-schema";
import {
  BINDING_DISABLE_WRITE,
  bindingUpsertWrite,
  isNewlyActivatedBinding,
  planBindingUpsert,
  shouldDisableBinding,
  type BindingUpsertPlan,
} from "@/lib/node-certificate-binding";
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
  withoutNodeTlsMaterial,
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
  const { db } = await import("@/db");
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
    const { db } = await import("@/db");
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

// --- Managed TLS binding lifecycle ------------------------------------------
//
// `certificate_server` is internal deployment state derived from node use.
// Selecting a certificate on a node ("bind and use") enables the
// `(certificateId, serverId)` row at the certificate's current desired
// generation with pending acknowledgement; when the node moves away, disables
// managed TLS, is deleted, or switches server/certificate, the old binding is
// disabled only when no other node on that server still uses the certificate.
// node-postgres runs the whole transition in a real interactive transaction;
// neon-http has none, so it uses reference-safe sequential ordering plus
// evidence-based compensation for a newly created/re-enabled binding if node
// persistence fails.

type DbHandle = Database;

async function withNodeTransaction<T>(
  database: DbHandle,
  driver: Parameters<typeof supportsInteractiveTransactions>[0],
  run: (tx: DbHandle) => Promise<T>,
): Promise<T> {
  if (supportsInteractiveTransactions(driver)) {
    return (
      database as unknown as {
        transaction: <Result>(
          callback: (tx: DbHandle) => Promise<Result>,
        ) => Promise<Result>;
      }
    ).transaction(run);
  }
  // neon-http exposes transaction() in Drizzle's common surface, but calling it
  // throws at runtime. Keep the same parent-first, reference-safe ordering used
  // by the other multi-statement mutations in this app.
  return run(database);
}

/** Whether a node actually serves a managed certificate given its protocol + settings. */
function nodeUsesManagedCertificate(
  protocol: string,
  settings: Record<string, unknown>,
): boolean {
  return (
    protocolSupportsTls(protocol) &&
    isNodeTlsEnabled(settings) &&
    !isNodeRealityEnabled(settings)
  );
}

async function loadBinding(
  tx: DbHandle,
  certificateId: string,
  serverId: string,
) {
  const [row] = await tx
    .select()
    .from(certificateServer)
    .where(
      and(
        eq(certificateServer.certificateId, certificateId),
        eq(certificateServer.serverId, serverId),
      ),
    );
  return row ?? null;
}

/** The certificate's current desired generation, plus the existing binding row. */
async function planBindingForNode(
  tx: DbHandle,
  serverId: string,
  certificateId: string,
): Promise<BindingUpsertPlan> {
  const [policy] = await tx
    .select({ desiredGeneration: managedCertificate.desiredGeneration })
    .from(managedCertificate)
    .where(eq(managedCertificate.id, certificateId));
  if (!policy) throw new Error("Certificate not found");
  const binding = await loadBinding(tx, certificateId, serverId);
  return planBindingUpsert(binding, policy.desiredGeneration);
}

async function upsertBinding(
  tx: DbHandle,
  plan: BindingUpsertPlan,
  certificateId: string,
  serverId: string,
): Promise<void> {
  if (plan.kind === "noop") return;
  await tx
    .insert(certificateServer)
    .values({ certificateId, serverId, ...bindingUpsertWrite(plan) })
    .onConflictDoUpdate({
      target: [certificateServer.certificateId, certificateServer.serverId],
      set: bindingUpsertWrite(plan),
    });
}

/** Precise count of other nodes on the server that actually serve the certificate. */
async function countNodesUsingCertificate(
  tx: DbHandle,
  serverId: string,
  certificateId: string,
  excludingNodeId?: string,
): Promise<number> {
  const rows = await tx
    .select({ protocol: node.protocol, settings: node.settings })
    .from(node)
    .where(
      and(
        eq(node.serverId, serverId),
        eq(node.certificateId, certificateId),
        ...(excludingNodeId ? [ne(node.id, excludingNodeId)] : []),
      ),
    );
  return rows.filter((row) =>
    nodeUsesManagedCertificate(row.protocol, row.settings),
  ).length;
}

/** Disables the binding only if no other node on the server still uses it. */
async function maybeDisableBinding(
  tx: DbHandle,
  certificateId: string,
  serverId: string,
  excludingNodeId: string,
): Promise<void> {
  const binding = await loadBinding(tx, certificateId, serverId);
  const others = await countNodesUsingCertificate(
    tx,
    serverId,
    certificateId,
    excludingNodeId,
  );
  if (!shouldDisableBinding(binding, others)) return;
  await tx
    .update(certificateServer)
    .set({ ...BINDING_DISABLE_WRITE })
    .where(
      and(
        eq(certificateServer.certificateId, certificateId),
        eq(certificateServer.serverId, serverId),
      ),
    );
}

/**
 * neon-http compensation: a newly created or re-enabled binding was already
 * written when node persistence failed. Re-check node references before
 * disabling so a concurrent node that legitimately uses the certificate on the
 * same server is never harmed; otherwise disable the row we just activated.
 */
async function compensateBindingAfterNodeFailure(
  database: DbHandle,
  certificateId: string | null | undefined,
  serverId: string | null | undefined,
  plan: BindingUpsertPlan | null,
): Promise<void> {
  if (!certificateId || !serverId) return;
  if (!isNewlyActivatedBinding(plan)) return;
  const stillUsed =
    (await countNodesUsingCertificate(database, serverId, certificateId)) > 0;
  if (stillUsed) return;
  await database
    .update(certificateServer)
    .set({ ...BINDING_DISABLE_WRITE })
    .where(
      and(
        eq(certificateServer.certificateId, certificateId),
        eq(certificateServer.serverId, serverId),
      ),
    );
}

export const createNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { db, databaseDriver } = await import("@/db");

    await validateManagedCertificateSelection(
      db,
      data.certificateId,
      data.tlsServerName,
      data.protocol,
      data.settings,
    );

    const id = randomUUID();
    let pendingPlan: BindingUpsertPlan | null = null;

    const run = async (tx: DbHandle) => {
      if (data.certificateId) {
        const plan = await planBindingForNode(
          tx,
          data.serverId,
          data.certificateId,
        );
        pendingPlan = plan;
        await upsertBinding(tx, plan, data.certificateId, data.serverId);
      }
      const [row] = await tx
        .insert(node)
        .values({
          id,
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
          // Strictly re-validate the fragment against the sing-box schema for
          // this protocol, after stripping X.509 material + raw server_name.
          settings: parseNodeSettings(
            data.protocol,
            withoutNodeTlsMaterial(data.settings),
          ),
        })
        .returning();
      if (!row) throw new Error("Failed to create node");
      return row;
    };

    let row;
    if (supportsInteractiveTransactions(databaseDriver)) {
      row = await withNodeTransaction(db, databaseDriver, run);
    } else {
      try {
        row = await run(db);
      } catch (error) {
        await compensateBindingAfterNodeFailure(
          db,
          data.certificateId,
          data.serverId,
          pendingPlan,
        );
        throw error;
      }
    }
    return { node: row };
  });

export const updateNode = createServerFn({ method: "POST" })
  .validator(updateNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { db, databaseDriver } = await import("@/db");
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
    const effectiveServerId = data.serverId ?? existingNode.serverId;
    const effectiveTlsServerName =
      tlsServerName === undefined ? existingNode.tlsServerName : tlsServerName;
    await validateManagedCertificateSelection(
      db,
      effectiveCertificateId,
      effectiveTlsServerName,
      effectiveProtocol,
      effectiveSettings,
    );

    const usesCertificate = (
      certificateId: string | null,
      protocol: string,
      settings: Record<string, unknown>,
    ) =>
      Boolean(certificateId) && nodeUsesManagedCertificate(protocol, settings);

    // The binding the node is moving to (if any) and the one it may be leaving.
    const oldUses = usesCertificate(
      existingNode.certificateId,
      existingNode.protocol,
      existingNode.settings,
    );
    const newUses = usesCertificate(
      effectiveCertificateId,
      effectiveProtocol,
      effectiveSettings,
    );
    const newBinding = newUses
      ? { certificateId: effectiveCertificateId!, serverId: effectiveServerId }
      : null;
    const oldBinding =
      oldUses && existingNode.certificateId
        ? {
            certificateId: existingNode.certificateId,
            serverId: existingNode.serverId,
          }
        : null;
    const bindingChanged =
      !newBinding ||
      !oldBinding ||
      newBinding.certificateId !== oldBinding.certificateId ||
      newBinding.serverId !== oldBinding.serverId;

    // Always re-sanitize and re-normalize the stored fragment: historical or
    // manually-entered X.509 material must never survive an edit.
    const sanitizedSettings = parseNodeSettings(
      effectiveProtocol,
      withoutNodeTlsMaterial(effectiveSettings),
    );

    // `undefined` => leave address alone; `null` => explicitly drop override
    // and fall back to server.address; string => set override.
    const addressUpdate =
      address === undefined
        ? {}
        : { address: address === null ? null : address };

    let pendingPlan: BindingUpsertPlan | null = null;
    let nodePersisted = false;

    const run = async (tx: DbHandle) => {
      if (newBinding) {
        const plan = await planBindingForNode(
          tx,
          newBinding.serverId,
          newBinding.certificateId,
        );
        pendingPlan = plan;
        await upsertBinding(
          tx,
          plan,
          newBinding.certificateId,
          newBinding.serverId,
        );
      }
      const [row] = await tx
        .update(node)
        .set({
          ...rest,
          ...(protocol ? { protocol } : {}),
          ...(certificateId !== undefined ? { certificateId } : {}),
          ...(tlsServerName !== undefined ? { tlsServerName } : {}),
          settings: sanitizedSettings,
          ...addressUpdate,
        })
        .where(eq(node.id, id))
        .returning();
      if (!row) {
        throw new Error("Not found");
      }
      nodePersisted = true;
      if (oldBinding && bindingChanged) {
        await maybeDisableBinding(
          tx,
          oldBinding.certificateId,
          oldBinding.serverId,
          id,
        );
      }
      return row;
    };

    if (supportsInteractiveTransactions(databaseDriver)) {
      return withNodeTransaction(db, databaseDriver, run);
    }
    try {
      return await run(db);
    } catch (error) {
      if (!nodePersisted) {
        await compensateBindingAfterNodeFailure(
          db,
          newBinding?.certificateId,
          newBinding?.serverId,
          pendingPlan,
        );
      }
      throw error;
    }
  });

/**
 * Server-side validation before a node binds a certificate. The certificate
 * selection is no longer restricted to pre-authorized server bindings: any
 * currently usable/issued certificate may be selected, and the bind-and-use
 * write enables the deployment row itself. Validates protocol TLS support,
 * TLS being enabled, Reality mutual exclusivity, certificate usability (issued
 * material within its validity window) and SNI domain coverage.
 */
async function validateManagedCertificateSelection(
  database: DbHandle,
  certificateId: string | null | undefined,
  tlsServerName: string | null | undefined,
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
  const [certificate] = await database
    .select({
      certificate: managedCertificate,
      materialId: certificateMaterial.id,
    })
    .from(managedCertificate)
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
    .where(eq(managedCertificate.id, certificateId));
  if (!certificate) {
    throw new Error("Certificate not found");
  }
  if (
    !isCertificateCurrentlyUsable(
      certificate.certificate,
      certificate.materialId !== null,
    )
  ) {
    throw new Error(
      "The selected certificate is not issued or is not currently usable",
    );
  }
  if (
    !tlsServerName ||
    !certificateCoversDomain(certificate.certificate.domains, tlsServerName)
  ) {
    throw new Error("TLS server name is not covered by the certificate");
  }
}

export const deleteNode = createServerFn({ method: "POST" })
  .validator(nodeIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { db, databaseDriver } = await import("@/db");
    const run = async (tx: DbHandle) => {
      const [row] = await tx
        .delete(node)
        .where(eq(node.id, data.id))
        .returning();
      if (!row) {
        throw new Error("Not found");
      }
      if (
        row.certificateId &&
        nodeUsesManagedCertificate(row.protocol, row.settings)
      ) {
        await maybeDisableBinding(tx, row.certificateId, row.serverId, row.id);
      }
      return { id: row.id };
    };
    return withNodeTransaction(db, databaseDriver, run);
  });
