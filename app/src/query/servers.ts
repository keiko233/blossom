import { createServerFn } from "@tanstack/react-start";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
  certificateServer,
  managedCertificate,
  node,
  server,
  type Server,
} from "@/db/proxy-schema";
import { generateAgentToken } from "@/lib/agent-token";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createServerSchema,
  serverIdSchema,
  updateServerSchema,
} from "@/orpc/proxy/schema";

/** TanStack Query key for the admin server list. */
export const SERVERS_QUERY_KEY = ["admin", "servers"] as const;

/**
 * Server row as served to the admin UI. `agentTokenHash` is deliberately
 * omitted: only the non-secret `prefix` is exposed for display. The plaintext
 * token is returned exactly once on create/reset (see `createServer` /
 * `regenerateServerToken`).
 */
export type ServerDTO = Omit<Server, "agentTokenHash"> & {
  certificateIds?: string[];
};

/** Server summary joined with the live child-node count for the list UI. */
export interface ServerListItem extends ServerDTO {
  nodeCount: number;
}

function toDTO(row: Server, certificateIds: string[] = []): ServerDTO {
  const { agentTokenHash: _agentTokenHash, ...rest } = row;
  return { ...rest, certificateIds };
}

async function certificateIdsByServer(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      serverId: certificateServer.serverId,
      certificateId: certificateServer.certificateId,
      enabled: certificateServer.enabled,
    })
    .from(certificateServer);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.enabled) continue;
    result.set(row.serverId, [
      ...(result.get(row.serverId) ?? []),
      row.certificateId,
    ]);
  }
  return result;
}

async function validateCertificateIds(certificateIds: string[]) {
  if (certificateIds.length === 0) return;
  const rows = await db
    .select({ id: managedCertificate.id })
    .from(managedCertificate)
    .where(inArray(managedCertificate.id, certificateIds));
  if (rows.length !== certificateIds.length) {
    throw new Error("One or more certificates do not exist");
  }
}

async function syncServerCertificates(serverId: string, ids: string[]) {
  const certificateIds = [...new Set(ids)];
  await validateCertificateIds(certificateIds);
  const current = await db
    .select({
      certificateId: certificateServer.certificateId,
      enabled: certificateServer.enabled,
    })
    .from(certificateServer)
    .where(eq(certificateServer.serverId, serverId));
  const currentIds = new Set(current.map((item) => item.certificateId));
  const used = await db
    .select({ certificateId: node.certificateId })
    .from(node)
    .where(eq(node.serverId, serverId));
  const allowed = new Set(certificateIds);
  if (
    used.some((item) => item.certificateId && !allowed.has(item.certificateId))
  ) {
    throw new Error("A certificate still assigned to a node cannot be removed");
  }
  const removed = current.filter(
    (item) => item.enabled && !allowed.has(item.certificateId),
  );
  const removing = removed.map((item) => item.certificateId);
  if (removing.length > 0) {
    await db
      .update(certificateServer)
      .set({ enabled: false, state: "pending", lastError: null })
      .where(
        and(
          eq(certificateServer.serverId, serverId),
          inArray(certificateServer.certificateId, removing),
        ),
      );
  }
  const reenabled = current
    .filter((item) => !item.enabled && allowed.has(item.certificateId))
    .map((item) => item.certificateId);
  if (reenabled.length > 0) {
    await db
      .update(certificateServer)
      .set({ enabled: true, state: "pending", lastError: null })
      .where(
        and(
          eq(certificateServer.serverId, serverId),
          inArray(certificateServer.certificateId, reenabled),
        ),
      );
  }
  const added = certificateIds.filter(
    (certificateId) => !currentIds.has(certificateId),
  );
  if (added.length > 0) {
    const certificates = await db
      .select({
        id: managedCertificate.id,
        generation: managedCertificate.desiredGeneration,
      })
      .from(managedCertificate)
      .where(inArray(managedCertificate.id, added));
    await db.insert(certificateServer).values(
      certificates.map((certificate) => ({
        serverId,
        certificateId: certificate.id,
        desiredGeneration: certificate.generation,
      })),
    );
  }
}

export const listServers = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    const [servers, nodeCounts, certificateIds] = await Promise.all([
      db.select().from(server).orderBy(desc(server.createdAt)),
      db
        .select({ serverId: node.serverId, count: count() })
        .from(node)
        .groupBy(node.serverId),
      certificateIdsByServer(),
    ]);

    const countByServer = new Map(
      nodeCounts.map((row) => [row.serverId, row.count]),
    );
    const result: ServerListItem[] = servers.map((row) => ({
      ...toDTO(row, certificateIds.get(row.id) ?? []),
      nodeCount: countByServer.get(row.id) ?? 0,
    }));
    return result;
  },
);

export const getServer = createServerFn({ method: "GET" })
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.select().from(server).where(eq(server.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    const certificateIds = await certificateIdsByServer();
    return toDTO(row, certificateIds.get(row.id) ?? []);
  });

export const createServer = createServerFn({ method: "POST" })
  .validator(createServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();

    const { certificateIds, ...serverData } = data;
    await validateCertificateIds(certificateIds);
    const [row] = await db
      .insert(server)
      .values({
        id: randomUUID(),
        ...serverData,
        agentTokenHash: credential.hash,
        agentTokenPrefix: credential.prefix,
      })
      .returning();
    await syncServerCertificates(row!.id, certificateIds);

    // Plaintext token is returned once here and never persisted.
    return { server: toDTO(row!, certificateIds), token: credential.token };
  });

export const updateServer = createServerFn({ method: "POST" })
  .validator(updateServerSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, certificateIds, ...rest } = data;

    const [row] = await db
      .update(server)
      .set(rest)
      .where(eq(server.id, id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    if (certificateIds !== undefined) {
      await syncServerCertificates(id, certificateIds);
    }
    const bindings = await certificateIdsByServer();
    return toDTO(row, bindings.get(id) ?? []);
  });

/**
 * Refuses to delete a server that still has nodes. The FK is RESTRICT in the
 * schema, so even a race here cannot orphan the rows — this check turns the
 * cryptic FK error into a clear user-facing message.
 */
export const deleteServer = createServerFn({ method: "POST" })
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

    const [countRow] = await db
      .select({ count: count() })
      .from(node)
      .where(eq(node.serverId, data.id));
    if ((countRow?.count ?? 0) > 0) {
      throw new Error(
        "Server still has nodes; move or delete them before removing it.",
      );
    }
    const [row] = await db
      .delete(server)
      .where(eq(server.id, data.id))
      .returning();
    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id };
  });

export const regenerateServerToken = createServerFn({ method: "POST" })
  .validator(serverIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();

    const [row] = await db
      .update(server)
      .set({
        agentTokenHash: credential.hash,
        agentTokenPrefix: credential.prefix,
      })
      .where(eq(server.id, data.id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id, token: credential.token };
  });
