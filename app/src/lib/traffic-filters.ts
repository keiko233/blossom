import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";

import { subscription } from "@/db/plan-schema";
import { trafficRecord } from "@/db/traffic-schema";

export interface TrafficWhereInput {
  /** Inclusive lower bound on `created_at`. */
  from: Date;
  /** Exclusive upper bound on `created_at`. */
  to: Date;
  serverId?: string;
  nodeId?: string;
  planId?: string;
  userId?: string;
}

/**
 * WHERE conditions of a traffic query. The range leads so the
 * `traffic_record_created_idx` index serves it; server / node / user filters
 * are served by their `(<col>, created_at)` indexes. The plan filter goes
 * through the subscription (traffic rows carry no plan) as an uncorrelated
 * `IN` subquery, so every query shape shares one FROM clause.
 */
export function buildTrafficConditions(input: TrafficWhereInput): SQL[] {
  const conditions: SQL[] = [
    gte(trafficRecord.createdAt, input.from),
    lt(trafficRecord.createdAt, input.to),
  ];
  if (input.serverId) {
    conditions.push(eq(trafficRecord.serverId, input.serverId));
  }
  if (input.nodeId) conditions.push(eq(trafficRecord.nodeId, input.nodeId));
  if (input.userId) conditions.push(eq(trafficRecord.userId, input.userId));
  if (input.planId) {
    conditions.push(
      sql`${trafficRecord.subscriptionId} in (select ${subscription.id} from ${subscription} where ${subscription.planId} = ${input.planId})`,
    );
  }
  return conditions;
}

export function buildTrafficWhere(input: TrafficWhereInput): SQL {
  // `and` of a non-empty list is never undefined.
  return and(...buildTrafficConditions(input)) as SQL;
}
