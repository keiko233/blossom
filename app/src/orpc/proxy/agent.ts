import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { db } from "@/db";
import { subscription } from "@/db/plan-schema";
import { node, server, type Server } from "@/db/proxy-schema";
import { trafficRecord, type NewTrafficRecord } from "@/db/traffic-schema";
import { hashAgentToken, parseBearerToken } from "@/lib/agent-token";
import { getNodeActiveSubscriptions } from "@/lib/subscription-access";

import { base } from "../base";
import { heartbeatSchema, trafficReportSchema } from "./schema";
import { compileServerConfig, type NodeInbound } from "./singbox";
import { buildInboundUser } from "./singbox-users";
import { resolveReportedTrafficUser } from "./traffic-user-codec";

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
 * Authenticates an agent by its server-level token (Authorization: Bearer
 * <token>). The token is hashed and matched against `server.agentTokenHash`,
 * resolving to exactly one server — the unit this request can read or update.
 * This is the sole public surface: no login session, no cross-server access,
 * no admin operations reachable here. Tokens used to live on individual nodes;
 * they were migrated onto the parent server and the shared `address`/heartbeat
 * fields with them.
 */
const agentProcedure = base.use(async ({ context, next }) => {
  const token = parseBearerToken(readHeader(context.headers, "authorization"));
  if (!token) {
    throw new ORPCError("UNAUTHORIZED");
  }

  const [row] = await db
    .select()
    .from(server)
    .where(eq(server.agentTokenHash, hashAgentToken(token)));
  if (!row) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return next({ context: { ...context, server: row as Server } });
});

/**
 * Returns the full sing-box config JSON for the calling agent's server: every
 * enabled inbound on the server, each populated with the subscriptions that are
 * currently entitled to that node. A server whose `enabled` is false (or that
 * has no enabled nodes) still receives a valid config — one with an empty
 * `inbounds` array and the `v2ray_api` hook kept on — so the agent tears down
 * the previous configuration on next pull. Expiry, bans, quota exhaustion, and
 * credential resets all take effect here: the agent's next config pull no
 * longer contains (or contains new) credentials.
 *
 * The explicit route/operationId/output metadata keeps the generated OpenAPI
 * spec consumable by progenitor (the agent's Rust client codegen): progenitor
 * names methods after operationIds and needs a response schema. The output is a
 * loose object on purpose — the agent treats the config as opaque JSON.
 */
export const getAgentConfig = agentProcedure
  .route({
    method: "GET",
    path: "/agent/config",
    operationId: "getAgentConfig",
  })
  .output(z.looseObject({}))
  .handler(async ({ context }) => {
    // A disabled server is still authenticated and heartbeated; its config has
    // no inbounds so the agent stops serving traffic. Nodes that are disabled
    // are skipped here so only live inbounds are compiled. Order by id for a
    // stable `inbounds` array so identical entitlement snapshots never produce a
    // spurious config diff that would re-hot-reload the agent.
    const nodes = context.server.enabled
      ? await db
          .select()
          .from(node)
          .where(
            and(eq(node.serverId, context.server.id), eq(node.enabled, true)),
          )
          .orderBy(asc(node.id))
      : [];

    // Fetch each node's active subscriptions in parallel — N concurrent queries
    // rather than N sequential — but preserve the (id-ordered) `nodes` order in
    // the resulting `built` array so the compiled config is deterministic.
    const perNodeUsers = await Promise.all(
      nodes.map(async (n) => {
        const subs = await getNodeActiveSubscriptions(n.id);
        return subs
          .map((sub) => buildInboundUser(n, sub))
          .filter((user): user is NonNullable<typeof user> => user !== null);
      }),
    );
    const built: NodeInbound[] = nodes.map((n, i) => ({
      node: n,
      users: perNodeUsers[i]!,
    }));

    // compileServerConfig drops inbounds whose users array is empty, so nodes
    // with no currently-entitled subscriptions never enter the running config.
    return compileServerConfig({ inbounds: built });
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
      .update(server)
      .set({ lastSeenAt: new Date(), agentVersion: input.agentVersion })
      .where(eq(server.id, context.server.id));
    return { ok: true };
  });

/**
 * Ingests per-user traffic deltas the agent read from sing-box's v2ray_api
 * stats (user name = coded identifier). Appends history rows and atomically
 * increments the subscription counters via SQL — never read-modify-write in
 * JS, since multiple agents report concurrently. Unknown subscription ids
 * (from a stale config still on the agent) are counted in `dropped`, not
 * treated as errors. No transactions on the neon-http driver: history is
 * inserted before the counters so a retry after a partial failure over-logs
 * rather than double-counts quota.
 *
 * The agent may still send legacy entries with the bare subscription id as
 * `subscriptionId` (e.g. agents running an older control plane still
 * single-inbound). Those are attributed to the calling server's only node when
 * exactly one node exists; otherwise the node is recorded as null and only the
 * subscription quota is updated. New entries use the coded `name` produced by
 * the codec; node ids that no longer belong to this server (the node was moved
 * or deleted) are dropped from `nodeId` while the subscription is still
 * credited — exactly the behaviour we want for accounting. See
 * `resolveReportedTrafficUser` for the full attribution matrix.
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
    const eligible = input.entries.filter(
      (entry) => entry.uplinkBytes + entry.downlinkBytes > 0,
    );
    if (eligible.length === 0) {
      return { accepted: 0, dropped: 0 };
    }

    // Resolve the calling server's node ids once; used for verifying coded node
    // ids and for legacy single-node attribution.
    const serverNodeRows = await db
      .select({ id: node.id })
      .from(node)
      .where(eq(node.serverId, context.server.id));
    const serverNodeIds = new Set(serverNodeRows.map((n) => n.id));

    const rekeyed = eligible.map((entry) => {
      const resolved = resolveReportedTrafficUser(
        entry.subscriptionId,
        serverNodeIds,
      );
      return {
        subscriptionId: resolved.subscriptionId,
        nodeId: resolved.nodeId,
        uplinkBytes: entry.uplinkBytes,
        downlinkBytes: entry.downlinkBytes,
      };
    });

    const subIds = [...new Set(rekeyed.map((r) => r.subscriptionId))];
    const subs = await db
      .select({ id: subscription.id, userId: subscription.userId })
      .from(subscription)
      .where(inArray(subscription.id, subIds));
    const userBySub = new Map(subs.map((sub) => [sub.id, sub.userId]));

    const known = rekeyed.filter((r) => userBySub.has(r.subscriptionId));
    if (known.length === 0) {
      return { accepted: 0, dropped: eligible.length };
    }

    const windowStartedAt = input.windowStartedAt
      ? new Date(input.windowStartedAt)
      : null;
    const windowEndedAt = input.windowEndedAt
      ? new Date(input.windowEndedAt)
      : null;

    const records: NewTrafficRecord[] = known.map((r) => ({
      id: randomUUID(),
      subscriptionId: r.subscriptionId,
      userId: userBySub.get(r.subscriptionId)!,
      nodeId: r.nodeId,
      serverId: context.server.id,
      uplinkBytes: r.uplinkBytes,
      downlinkBytes: r.downlinkBytes,
      windowStartedAt,
      windowEndedAt,
    }));
    await db.insert(trafficRecord).values(records);

    // A subscription appears once per report (one stats counter per user), but
    // sum defensively in case an agent splits entries.
    const deltaBySub = new Map<string, number>();
    for (const r of known) {
      deltaBySub.set(
        r.subscriptionId,
        (deltaBySub.get(r.subscriptionId) ?? 0) +
          r.uplinkBytes +
          r.downlinkBytes,
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

    return { accepted: known.length, dropped: eligible.length - known.length };
  });
