import { Badge } from "@/components/ui/badge";
import type { SubscriptionStatus } from "@/db/plan-schema";
import { m } from "@/paraglide/messages";

export interface SubscriptionStatusBadgeProps {
  status: SubscriptionStatus;
}

export function SubscriptionStatusBadge({
  status,
}: SubscriptionStatusBadgeProps) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-emerald-500"
          />
          {m.component_subscription_status_active()}
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-muted-foreground/64"
          />
          {m.component_subscription_status_expired()}
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-destructive"
          />
          {m.component_subscription_status_cancelled()}
        </Badge>
      );
  }
}
