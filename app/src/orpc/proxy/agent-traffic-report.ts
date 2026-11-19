import type { z } from "zod";

import type { Database } from "@/db";
import {
  computeTrafficReportHash,
  listServerNodeIds,
  recordAgentTraffic,
  type RecordTrafficResult,
} from "@/query/agent";

import type { trafficReportSchema } from "./schema";
import { resolveReportedTrafficUser } from "./traffic-user-codec";

export type AgentTrafficReportInput = z.infer<typeof trafficReportSchema>;

/**
 * Attributes one agent traffic report to the calling server's nodes and
 * applies it. Both the v1 HTTP ingestion and the v2 WebSocket `traffic.report`
 * call this, so attribution, deduplication and retention behave the same on
 * either transport. `sessionId` is set only on v2, where it fences the write
 * to the connection that submitted the report.
 *
 * Throws {@link TrafficReportConflictError} for a reused report id with
 * different content and {@link AgentSessionReplacedError} for a fenced v2
 * report. Callers map those to their own transport's response.
 */
export async function applyAgentTrafficReport(
  serverId: string,
  input: AgentTrafficReportInput,
  options: { sessionId?: string; database?: Database } = {},
): Promise<RecordTrafficResult | { accepted: 0; dropped: 0 }> {
  const eligible = input.entries.filter(
    (entry) => entry.uplinkBytes + entry.downlinkBytes > 0,
  );
  if (eligible.length === 0 && input.reportId === undefined) {
    return { accepted: 0, dropped: 0 };
  }

  // Resolve the calling server's node ids once; used for verifying coded node
  // ids and for legacy single-node attribution.
  const serverNodeIds = new Set(
    await listServerNodeIds(serverId, options.database),
  );

  const entries = eligible.map((entry) => {
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

  return recordAgentTraffic({
    serverId,
    reportId: input.reportId,
    contentHash:
      input.reportId === undefined
        ? undefined
        : computeTrafficReportHash(input),
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.database === undefined ? {} : { database: options.database }),
    windowStartedAt: input.windowStartedAt
      ? new Date(input.windowStartedAt)
      : null,
    windowEndedAt: input.windowEndedAt ? new Date(input.windowEndedAt) : null,
    entries,
  });
}
