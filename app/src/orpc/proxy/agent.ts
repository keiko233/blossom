import { ORPCError } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { db } from "@/db";
import { subscription } from "@/db/plan-schema";
import { node, type Node } from "@/db/proxy-schema";
import { trafficRecord, type NewTrafficRecord } from "@/db/traffic-schema";
import { hashAgentToken, parseBearerToken } from "@/lib/agent-token";
import { getNodeActiveSubscriptions } from "@/lib/subscription-access";

import { base } from "../base";
import { heartbeatSchema, trafficReportSchema } from "./schema";
import { nodeToSingboxConfig } from "./singbox";
import { buildInboundUser } from "./singbox-users";

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
 * Returns the full sing-box config JSON for the calling agent's node, with the
 * currently entitled subscriptions embedded as inbound users. Expiry, bans,
 * quota exhaustion, and credential resets all take effect here: the agent's
 * next config pull simply no longer contains (or contains new) credentials.
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
  .handler(async ({ context }) => {
    const subs = await getNodeActiveSubscriptions(context.node.id);
    const users = subs
      .map((sub) => buildInboundUser(context.node, sub))
      .filter((user) => user !== null);
    return nodeToSingboxConfig(context.node, { users });
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

/**
 * Ingests per-user traffic deltas the agent read from sing-box's v2ray_api
 * stats (user name = subscription id). Appends history rows and atomically
 * increments the subscription counters via SQL — never read-modify-write in
 * JS, since multiple agents report concurrently. Unknown subscription ids
 * (from a stale config still on the node) are counted in `dropped`, not
 * treated as errors. No transactions on the neon-http driver: history is
 * inserted before the counters so a retry after a partial failure over-logs
 * rather than double-counts quota.
 */
export const reportAgentTraffic = agentProcedure
  .route({
    method: "POST",
    path: "/agent/traffic",
    operationId: "reportAgentTraffic",
  })
  .input(trafficReportSchema)
  .output(z.object({ accepted: z.number().int(), dropped: z.number().int() }))
  .handler(async ({ context, input }) => {
    const entries = input.entries.filter(
      (entry) => entry.uplinkBytes + entry.downlinkBytes > 0,
    );
    if (entries.length === 0) {
      return { accepted: 0, dropped: 0 };
    }

    const ids = [...new Set(entries.map((entry) => entry.subscriptionId))];
    const subs = await db
      .select({ id: subscription.id, userId: subscription.userId })
      .from(subscription)
      .where(inArray(subscription.id, ids));
    const userBySub = new Map(subs.map((sub) => [sub.id, sub.userId]));

    const known = entries.filter((entry) =>
      userBySub.has(entry.subscriptionId),
    );
    if (known.length === 0) {
      return { accepted: 0, dropped: entries.length };
    }

    const windowStartedAt = input.windowStartedAt
      ? new Date(input.windowStartedAt)
      : null;
    const windowEndedAt = input.windowEndedAt
      ? new Date(input.windowEndedAt)
      : null;

    const records: NewTrafficRecord[] = known.map((entry) => ({
      id: randomUUID(),
      subscriptionId: entry.subscriptionId,
      userId: userBySub.get(entry.subscriptionId)!,
      nodeId: context.node.id,
      uplinkBytes: entry.uplinkBytes,
      downlinkBytes: entry.downlinkBytes,
      windowStartedAt,
      windowEndedAt,
    }));
    await db.insert(trafficRecord).values(records);

    // A subscription appears once per report (one stats counter per user), but
    // sum defensively in case an agent splits entries.
    const deltaBySub = new Map<string, number>();
    for (const entry of known) {
      deltaBySub.set(
        entry.subscriptionId,
        (deltaBySub.get(entry.subscriptionId) ?? 0) +
          entry.uplinkBytes +
          entry.downlinkBytes,
      );
    }
    for (const [subscriptionId, delta] of deltaBySub) {
      await db
        .update(subscription)
        .set({
          trafficUsedBytes: sql`${subscription.trafficUsedBytes} + ${delta}`,
        })
        .where(eq(subscription.id, subscriptionId));
    }

    return { accepted: known.length, dropped: entries.length - known.length };
  });
