import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { formatBytes } from "@/lib/format";
import { m } from "@/paraglide/messages";

export interface SubscriptionQuotaUsageProps {
  trafficQuotaBytes: number;
  trafficUsedBytes: number;
  size?: "sm" | "md";
}

export function SubscriptionQuotaUsage({
  trafficQuotaBytes,
  trafficUsedBytes,
  size = "md",
}: SubscriptionQuotaUsageProps) {
  const unlimited = trafficQuotaBytes === 0;

  return (
    <div
      className={
        size === "sm"
          ? "flex min-w-28 flex-col gap-1"
          : "flex min-w-36 flex-col gap-1"
      }
    >
      <span className="text-xs text-muted-foreground">
        {formatBytes(trafficUsedBytes)} /{" "}
        {unlimited
          ? m.component_subscription_quota_unlimited()
          : formatBytes(trafficQuotaBytes)}
      </span>
      {!unlimited && (
        <Meter value={trafficUsedBytes} max={trafficQuotaBytes}>
          <MeterTrack className="rounded-full">
            <MeterIndicator />
          </MeterTrack>
        </Meter>
      )}
    </div>
  );
}
