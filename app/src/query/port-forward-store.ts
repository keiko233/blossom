import type { ManagedIntentPortForward } from "@blossom/contracts/agent-config-v3";
import { and, eq, inArray } from "drizzle-orm";

import { type Database, db } from "@/db";
import { portForward } from "@/db/managed-network-schema";
import { node, server } from "@/db/proxy-schema";

export interface SubscriptionPortForward {
  forward: {
    id: string;
    runtimeTag: string;
    name: string;
    listenPort: number;
    network: "tcp" | "udp" | "both";
    targetNodeId: string | null;
    enabled: boolean;
  };
  transitServer: {
    id: string;
    name: string;
    address: string;
    enabled: boolean;
  };
}

/**
 * Enabled port forwards on enabled transit servers that target any of the
 * supplied exit nodes. Kept in a store module free of admin-auth imports so
 * subscription and agent-compile paths do not pull in server-fn/auth env.
 */
export async function listSubscriptionPortForwards(
  targetNodeIds: readonly string[],
  database: Database = db,
): Promise<SubscriptionPortForward[]> {
  if (targetNodeIds.length === 0) {
    return [];
  }
  return database
    .select({
      forward: {
        id: portForward.id,
        runtimeTag: portForward.runtimeTag,
        name: portForward.name,
        listenPort: portForward.listenPort,
        network: portForward.network,
        targetNodeId: portForward.targetNodeId,
        enabled: portForward.enabled,
      },
      transitServer: {
        id: server.id,
        name: server.name,
        address: server.address,
        enabled: server.enabled,
      },
    })
    .from(portForward)
    .innerJoin(server, eq(server.id, portForward.serverId))
    .where(
      and(
        inArray(portForward.targetNodeId, [...targetNodeIds]),
        eq(portForward.enabled, true),
        eq(server.enabled, true),
      ),
    )
    .orderBy(portForward.id);
}

/**
 * Resolves the enabled port forwards of one server into the immutable stage
 * intent shape. A managed exit node contributes its client-facing address
 * fallback and its listen port; an external target contributes its own
 * host:port.
 */
export async function loadServerPortForwards(
  serverId: string,
  database: Database = db,
): Promise<ManagedIntentPortForward[]> {
  const rows = await database
    .select({
      forward: portForward,
      targetNode: node,
      targetServer: server,
    })
    .from(portForward)
    .leftJoin(node, eq(node.id, portForward.targetNodeId))
    .leftJoin(server, eq(server.id, node.serverId))
    .where(
      and(eq(portForward.serverId, serverId), eq(portForward.enabled, true)),
    )
    .orderBy(portForward.id);

  const forwards: ManagedIntentPortForward[] = [];
  for (const row of rows) {
    const overrideAddress = row.forward.targetNodeId
      ? (row.targetNode?.address ?? row.targetServer?.address ?? null)
      : row.forward.targetAddress;
    const overridePort = row.forward.targetNodeId
      ? (row.targetNode?.listenPort ?? null)
      : row.forward.targetPort;
    if (overrideAddress === null || overridePort === null) {
      continue;
    }
    forwards.push({
      forwardId: row.forward.id,
      runtimeTag: row.forward.runtimeTag,
      listenAddress: row.forward.listenAddress,
      listenPort: row.forward.listenPort,
      network: row.forward.network,
      overrideAddress,
      overridePort,
      outboundTag: row.forward.outboundTag,
    });
  }
  return forwards;
}
