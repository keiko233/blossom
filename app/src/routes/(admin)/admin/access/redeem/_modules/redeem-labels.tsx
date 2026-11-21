import { Badge } from "@/components/ui/badge";
import type { RedeemBatchStatus, RedeemMode } from "@/lib/redeem-batch";
import { m } from "@/paraglide/messages";

export const MODE_LABELS: Record<RedeemMode, () => string> = {
  new: () => m.admin_redeem_mode_new(),
  extend: () => m.admin_redeem_mode_extend(),
};

export const STATUS_LABELS: Record<RedeemBatchStatus, () => string> = {
  active: () => m.admin_redeem_status_active(),
  disabled: () => m.admin_redeem_status_disabled(),
  expired: () => m.admin_redeem_status_expired(),
  exhausted: () => m.admin_redeem_status_exhausted(),
};

const STATUS_DOT: Record<RedeemBatchStatus, string> = {
  active: "bg-emerald-500",
  disabled: "bg-destructive",
  expired: "bg-muted-foreground/64",
  exhausted: "bg-amber-500",
};

export function RedeemStatusBadge({ status }: { status: RedeemBatchStatus }) {
  return (
    <Badge variant="outline">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${STATUS_DOT[status]}`}
      />
      {STATUS_LABELS[status]()}
    </Badge>
  );
}

/** "30 days", or "30 days (plan)" when the batch follows the plan's duration. */
export function durationLabel(
  durationDays: number | null,
  planDurationDays: number,
): string {
  return durationDays === null
    ? m.admin_redeem_duration_plan({ days: planDurationDays })
    : m.admin_redeem_duration_days({ days: durationDays });
}
