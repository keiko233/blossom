import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { node, type Node } from "@/db/proxy-schema";
import { hashAgentToken, parseBearerToken } from "@/lib/agent-token";

import { base } from "../base";
import { heartbeatSchema } from "./schema";
import { nodeToSingboxConfig } from "./singbox";

function readHeader(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()];
}

/**
 * Authenticates an agent by its per-node token (Authorization: Bearer <token>).
 * The token is hashed and matched against `agentTokenHash`, resolving to exactly
 * one node — the only node this request can ever read or update (least privilege).
 * This is the sole public surface: no login session, no cross-node access, no
 * admin operations reachable here.
 */
const agentProcedure = base.use(async ({ context, next }) => {
  const token = parseBearerToken(readHeader(context.headers, "authorization"));
  if (!token) {
    throw new ORPCError("UNAUTHORIZED");
  }

  const [row] = await db
    .select()
    .from(node)
    .where(eq(node.agentTokenHash, hashAgentToken(token)));
  if (!row) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return next({ context: { ...context, node: row as Node } });
});

/**
 * Returns the full sing-box config JSON for the calling agent's node. The agent
 * applies it via process hot-reload. Users are empty here until the users module
 * binds subscribers; the config still carries the v2ray_api hooks.
 *
 * The explicit route/operationId/output metadata keeps the generated OpenAPI spec
 * consumable by progenitor (the agent's Rust client codegen): progenitor names
 * methods after operationIds and needs a response schema. The output is a loose
 * object on purpose — the agent treats the config as opaque JSON.
 */
export const getAgentConfig = agentProcedure
  .route({
    method: "GET",
    path: "/agent/config",
    operationId: "getAgentConfig",
  })
  .output(z.looseObject({}))
  .handler(({ context }) => {
    return nodeToSingboxConfig(context.node);
  });

export const agentHeartbeat = agentProcedure
  .route({
    method: "POST",
    path: "/agent/heartbeat",
    operationId: "agentHeartbeat",
  })
  .input(heartbeatSchema)
  .output(z.object({ ok: z.boolean() }))
  .handler(async ({ context, input }) => {
    await db
      .update(node)
      .set({ lastSeenAt: new Date(), agentVersion: input.agentVersion })
      .where(eq(node.id, context.node.id));
    return { ok: true };
  });
