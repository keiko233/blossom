import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { authenticateStaticAgentToken } from "@/lib/agent-static-auth";
import { parseBearerToken } from "@/lib/agent-token";
import {
  TrafficReportConflictError,
  updateAgentHeartbeat,
} from "@/query/agent";
import { applyAgentCertificateDeployments } from "@/query/certificate-agent";

import { base } from "../base";
import {
  buildAgentConfigV3Output,
  buildAgentDesiredState,
} from "./agent-desired-state";
import { applyAgentTrafficReport } from "./agent-traffic-report";
import { ManagedNetworkingRequiresV2Error } from "./managed-singbox";
import {
  agentConfigV3OutputSchema,
  heartbeatSchema,
  trafficReportOutputSchema,
  trafficReportSchema,
} from "./schema";

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
 * Authenticates an agent by its optional static backup token
 * (Authorization: Bearer <token>). The token is hashed and matched against
 * `server.agentTokenHash`, resolving to exactly one server — the unit this
 * request can read or update. OAuth machine tokens are never accepted here.
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

  const authentication = await authenticateStaticAgentToken(token, {
    allowDisabled: true,
  });
  if (!authentication) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return next({ context: { ...context, server: authentication.server } });
});

/**
 * Returns the full V3 agent desired state for the calling agent's server: the
 * complete sing-box base config (every enabled inbound populated with the
 * subscriptions currently entitled to that node), the managed TLS bindings the
 * agent must provision certificates for, the certificate artifacts it may
 * install, and a `desiredRevision` that changes exactly when that desired
 * state changes. A disabled server (or one with no enabled nodes) still
 * receives a valid config with an empty `inbounds` array so the agent tears
 * down the previous configuration on next pull. Expiry, bans, quota
 * exhaustion, and credential resets all take effect here: the agent's next
 * pull no longer contains (or contains new) credentials.
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
    // `context.server` (and so the sequence below) was read in the auth
    // middleware, BEFORE the desired state is compiled. Keep that order: a
    // gate-recorded change commits atomically with its rows, so reading the
    // sequence first can only pair it with the same or NEWER content (the
    // subscription then lags, which is safe); reading content first could pair
    // a newer sequence with older credentials. See
    // subscription-credential-rotation.integration.test.ts.
    //
    // The revision pairs the server's monotonic publish-gate sequence with
    // the content hash. The agent treats it as opaque (equality + content
    // byte-compare only); the subscription gate parses the seq prefix back
    // out of heartbeat `appliedRevision` reports.
    try {
      const desired = await buildAgentDesiredState(context.server);
      return buildAgentConfigV3Output(context.server, desired);
    } catch (error) {
      if (error instanceof ManagedNetworkingRequiresV2Error) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      throw error;
    }
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
 * Ingests per-user traffic deltas the agent derived from sing-box's
 * connection-event stream (user identifier = coded node+subscription name, or
 * a bare subscription id for username-keyed protocols). History rows, the
 * subscription counter increments and, when the report has a `reportId`, the
 * idempotency ledger row are written by ONE SQL statement
 * (`recordAgentTraffic`), so the report is applied entirely or not at all on
 * both database drivers — never read-modify-write in JS, since multiple agents
 * report concurrently.
 *
 * Reports with a `reportId` are idempotent per server: a retry or concurrent
 * duplicate of an applied report writes nothing and returns the original
 * counts with `duplicate: true`; the same id with different content is
 * rejected with CONFLICT. Reports without one (agents that predate the field)
 * are still atomic but are NOT replay-safe: a retry after a lost response is
 * counted again. Unknown subscription ids (from a stale config still on the
 * agent) are counted in `dropped`, not treated as errors; expired or cancelled
 * subscriptions still accrue.
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
  .output(trafficReportOutputSchema)
  .handler(async ({ context, input }) => {
    try {
      const result = await applyAgentTrafficReport(context.server.id, input);
      if (!("duplicate" in result)) {
        return result;
      }
      return {
        accepted: result.accepted,
        dropped: result.dropped,
        ...(input.reportId === undefined
          ? {}
          : { reportId: input.reportId, duplicate: result.duplicate }),
      };
    } catch (error) {
      if (error instanceof TrafficReportConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      throw error;
    }
  });
