import type { SubscriptionStatus } from "@/db/plan-schema";
import { getQuotaUsageRatio } from "@/lib/admin-overview";
import { toCsv } from "@/lib/csv";
import { getEffectiveSubscriptionStatus } from "@/lib/subscription-helpers";

export interface SubscriptionCsvRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  planName: string;
  status: SubscriptionStatus;
  startedAt: Date;
  expiresAt: Date;
  trafficQuotaBytes: number;
  trafficUsedBytes: number;
  deviceLimit: number;
  createdAt: Date;
}

export const SUBSCRIPTION_CSV_COLUMNS = [
  "id",
  "user_id",
  "user_name",
  "user_email",
  "plan",
  "status",
  "effective_status",
  "started_at",
  "expires_at",
  "traffic_quota_bytes",
  "traffic_used_bytes",
  "usage_percent",
  "device_limit",
  "created_at",
] as const;

/** CSV text for the admin export. */
export function subscriptionsToCsv(
  rows: readonly SubscriptionCsvRow[],
): string {
  return toCsv(
    SUBSCRIPTION_CSV_COLUMNS,
    rows.map((row) => {
      const ratio = getQuotaUsageRatio(
        row.trafficQuotaBytes,
        row.trafficUsedBytes,
      );
      return [
        row.id,
        row.userId,
        row.userName,
        row.userEmail,
        row.planName,
        row.status,
        getEffectiveSubscriptionStatus(row),
        row.startedAt,
        row.expiresAt,
        row.trafficQuotaBytes,
        row.trafficUsedBytes,
        // Empty for unlimited quotas.
        ratio === null ? null : Math.round(ratio * 1000) / 10,
        row.deviceLimit,
        row.createdAt,
      ];
    }),
  );
}
