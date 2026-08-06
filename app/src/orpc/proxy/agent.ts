import { ORPCError } from "@orpc/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { NewTrafficRecord } from "@/db/traffic-schema";
import { hashAgentToken, parseBearerToken } from "@/lib/agent-token";
import {
  findAgentServerByTokenHash,
  getSubscriptionUserMap,
  listEnabledServerNodes,
  listServerNodeIds,
  recordAgentTraffic,
  updateAgentHeartbeat,
} from "@/query/agent";
import {
  applyAgentCertificateDeployments,
  getCertificateAgentContext,
} from "@/query/certificate-agent";
import { getNodeActiveSubscriptions } from "@/query/subscription-access";

import { base } from "../base";
import {
  agentConfigV3OutputSchema,
  heartbeatSchema,
  trafficReportSchema,
} from "./schema";
import {
  buildCertificateArtifacts,
  buildGenerationByCertificateId,
  buildManagedTlsBindings,
  compileServerConfig,
  computeDesiredRevision,
  filterCertificateArtifactsForBindings,
  type NodeInbound,
} from "./singbox";
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

  const row = await findAgentServerByTokenHash(hashAgentToken(token));
  if (!row) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return next({ context: { ...context, server: row } });
});

async function compileAgentServerConfig(serverId: string, enabled: boolean) {
  const nodes = enabled ? await listEnabledServerNodes(serverId) : [];
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
  const materialized = built.filter(({ users }) => users.length > 0);
  const config = compileServerConfig({ inbounds: built });
  return {
    config,
    materializedNodes: materialized.map(({ node }) => node),
    materializedNodeIds: materialized.map(({ node }) => node.id),
  };
}

/**
 * Returns the full V3 agent desired state for the calling agent's server: the
 * complete sing-box base config (every enabled inbound populated with the
 * subscriptions currently entitled to that node), the managed TLS bindings the
 * agent must provision certificates for, the certificate artifacts it may
 * install, and a `desiredRevision` that changes exactly when that desired
 * state changes. A disabled server (or one with no enabled nodes) still
 * receives a valid config — with an empty `inbounds` array and the `v2ray_api`
 * hook kept on — so the agent tears down the previous configuration on next
 * pull. Expiry, bans, quota exhaustion, and credential resets all take effect
 * here: the agent's next pull no longer contains (or contains new) credentials.
 *
 * The base sing-box config never carries certificate material or on-disk
 * certificate paths; `managedTlsBindings` + `certificateArtifacts` describe
 * the certificate work the agent must do. Everything except the sing-box base
 * config object is fully typed by Zod for the generated OpenAPI spec consumed
 * by progenitor (the agent's Rust client codegen).
 */
export const getAgentConfigV3 = agentProcedure
  .route({
    method: "GET",
    path: "/agent/config/v3",
    operationId: "getAgentConfigV3",
  })
  .output(agentConfigV3OutputSchema)
  .handler(async ({ context }) => {
    const [
      { config, materializedNodes, materializedNodeIds },
      certificateContext,
    ] = await Promise.all([
      compileAgentServerConfig(context.server.id, context.server.enabled),
      getCertificateAgentContext(context.server.id),
    ]);

    // Desired generation per certificate as seen by this server, derived only
    // from enabled bindings so a node never looks managed without a matching
    // artifact.
    const generationByCertificateId =
      buildGenerationByCertificateId(certificateContext);

    const managedTlsBindings = buildManagedTlsBindings(
      materializedNodes,
      generationByCertificateId,
    );
    const certificateArtifacts = filterCertificateArtifactsForBindings(
      buildCertificateArtifacts(certificateContext),
      managedTlsBindings,
    );

    const desiredRevision = computeDesiredRevision(
      config,
      managedTlsBindings,
      certificateArtifacts,
      materializedNodeIds,
    );

    return {
      apiVersion: 3 as const,
      agent: {
        configPollIntervalSeconds: context.server.configPollIntervalSeconds,
        heartbeatIntervalSeconds: context.server.heartbeatIntervalSeconds,
      },
      desiredRevision,
      materializedNodeIds,
      singboxConfig: config,
      managedTlsBindings,
      certificateArtifacts,
    };
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
    await updateAgentHeartbeat(context.server.id, input);
    await applyAgentCertificateDeployments(
      context.server.id,
      input.certificateDeployments,
    );
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
    const serverNodeIds = new Set(await listServerNodeIds(context.server.id));

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
    const userBySub = await getSubscriptionUserMap(subIds);

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
    await recordAgentTraffic(records, deltaBySub);

    return { accepted: known.length, dropped: eligible.length - known.length };
  });
