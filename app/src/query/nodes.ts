import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { node } from "@/db/proxy-schema";
import { server } from "@/db/proxy-schema";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  createNodeSchema,
  nodeIdSchema,
  parseNodeSettings,
  updateNodeSchema,
} from "@/orpc/proxy/schema";

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
  settings: Record<string, unknown>;
  serverSummary: {
    id: string;
    name: string;
    address: string;
    enabled: boolean;
    agentTokenPrefix: string;
    lastSeenAt: Date | null;
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
    settings: n.settings,
    serverSummary: {
      id: s.id,
      name: s.name,
      address: s.address,
      enabled: s.enabled,
      agentTokenPrefix: s.agentTokenPrefix,
      lastSeenAt: s.lastSeenAt,
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
      settings: n.settings,
      serverSummary: {
        id: s.id,
        name: s.name,
        remark: s.remark,
        address: s.address,
        enabled: s.enabled,
        agentTokenPrefix: s.agentTokenPrefix,
        lastSeenAt: s.lastSeenAt,
      },
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    } satisfies NodeDetail;
  });

export const createNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();

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
        // Strictly re-validate the fragment against the sing-box schema for this protocol.
        settings: parseNodeSettings(data.protocol, data.settings),
      })
      .returning();

    return { node: row };
  });

export const updateNode = createServerFn({ method: "POST" })
  .validator(updateNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, protocol, settings, address, ...rest } = data;

    // Validating settings needs the effective protocol (may be unchanged on edit).
    let settingsUpdate:
      | Record<string, never>
      | { settings: ReturnType<typeof parseNodeSettings> } = {};
    if (settings !== undefined) {
      let effectiveProtocol = protocol;
      if (!effectiveProtocol) {
        const [existing] = await db
          .select({ protocol: node.protocol })
          .from(node)
          .where(eq(node.id, id));
        if (!existing) {
          throw new Error("Not found");
        }
        effectiveProtocol = existing.protocol;
      }
      settingsUpdate = {
        settings: parseNodeSettings(effectiveProtocol, settings),
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
