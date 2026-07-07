import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { node } from "@/db/proxy-schema";
import { generateAgentToken } from "@/lib/agent-token";
import { getAuth } from "@/lib/auth";
import {
  createNodeSchema,
  nodeIdSchema,
  parseNodeSettings,
  updateNodeSchema,
} from "@/orpc/proxy/schema";

/** TanStack Query key for the admin node list. */
export const NODES_QUERY_KEY = ["admin", "nodes"] as const;

/**
 * All node administration goes through these server functions (never the public
 * API). Each one asserts an authenticated admin session before touching the DB.
 */
async function ensureAdmin() {
  const headers = getRequestHeaders();
  const session = await getAuth().api.getSession({ headers });
  if (!session) {
    throw new Error("Unauthorized");
  }
  if (session.user.role !== "admin") {
    throw new Error("Forbidden");
  }
  return session;
}

export const listNodes = createServerFn({ method: "GET" }).handler(async () => {
  await ensureAdmin();
  return db.select().from(node).orderBy(desc(node.createdAt));
});

export const getNode = createServerFn({ method: "GET" })
  .validator(nodeIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [row] = await db.select().from(node).where(eq(node.id, data.id));
    if (!row) {
      throw new Error("Not found");
    }
    return row;
  });

export const createNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();

    const [row] = await db
      .insert(node)
      .values({
        id: randomUUID(),
        name: data.name,
        remark: data.remark,
        tags: data.tags,
        enabled: data.enabled,
        address: data.address,
        listenPort: data.listenPort,
        protocol: data.protocol,
        // Strictly re-validate the fragment against the sing-box schema for this protocol.
        settings: parseNodeSettings(data.protocol, data.settings),
        agentTokenHash: credential.hash,
        agentTokenPrefix: credential.prefix,
      })
      .returning();

    // Plaintext token is returned once here and never persisted.
    return { node: row, token: credential.token };
  });

export const updateNode = createServerFn({ method: "POST" })
  .validator(updateNodeSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { id, protocol, settings, ...rest } = data;

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

    const [row] = await db
      .update(node)
      .set({
        ...rest,
        ...(protocol ? { protocol } : {}),
        ...settingsUpdate,
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

export const regenerateAgentToken = createServerFn({ method: "POST" })
  .validator(nodeIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const credential = generateAgentToken();

    const [row] = await db
      .update(node)
      .set({
        agentTokenHash: credential.hash,
        agentTokenPrefix: credential.prefix,
      })
      .where(eq(node.id, data.id))
      .returning();

    if (!row) {
      throw new Error("Not found");
    }
    return { id: row.id, token: credential.token };
  });
