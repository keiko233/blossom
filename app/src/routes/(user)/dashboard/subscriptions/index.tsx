import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";

import {
  SubscriptionQuotaUsage,
  SubscriptionStatusBadge,
} from "@/components/subscriptions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import type { SubscriptionStatus } from "@/db/plan-schema";
import { currentUserQueryKey, getCurrentUser } from "@/lib/current-user";
import { formatDate } from "@/lib/format";
import {
  buildSubscriptionUrl,
  getEffectiveSubscriptionStatus,
  isSubscriptionUsable,
} from "@/lib/subscription-helpers";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(user)/dashboard/subscriptions/")({
  staticData: {
    crumb: () => m.user_subscriptions_title(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { user } = Route.useRouteContext();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: currentUserQueryKey(user.id),
    queryFn: () => getCurrentUser(),
  });

  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
        <span className="sr-only">{m.user_subscriptions_loading()}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <Alert variant="error" className="max-w-md">
          <AlertTitle>{m.user_subscriptions_error()}</AlertTitle>
          <AlertDescription>{m.user_subscriptions_error()}</AlertDescription>
        </Alert>
        <Button onClick={() => void refetch()}>
          {m.user_subscriptions_error_retry()}
        </Button>
      </div>
    );
  }

  const { subscriptions } = data;

  if (subscriptions.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.user_subscriptions_empty()}</EmptyTitle>
          <EmptyDescription>
            {m.user_subscriptions_empty_description()}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <h1 className="font-heading text-2xl font-semibold">
        {m.user_subscriptions_title()}
      </h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {subscriptions.map((sub) => (
          <SubscriptionCard key={sub.id} subscription={sub} />
        ))}
      </div>
    </div>
  );
}

interface SubscriptionCardProps {
  subscription: {
    id: string;
    planName: string;
    status: SubscriptionStatus;
    startedAt: Date | string | number;
    expiresAt: Date | string | number;
    trafficQuotaBytes: number;
    trafficUsedBytes: number;
    deviceLimit: number;
    token: string;
  };
}

function SubscriptionCard({ subscription: sub }: SubscriptionCardProps) {
  const effectiveStatus = getEffectiveSubscriptionStatus(sub);
  const usable = isSubscriptionUsable(sub);

  const handleCopy = async () => {
    if (!usable) return;
    const url = buildSubscriptionUrl(sub.token, window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
      toastManager.add({
        type: "success",
        title: m.user_subscriptions_copy_url_success(),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.user_subscriptions_copy_url_error(),
      });
    }
  };

  const deviceLabel =
    sub.deviceLimit === 0
      ? m.user_subscriptions_device_unlimited()
      : sub.deviceLimit === 1
        ? m.user_subscriptions_device_one()
        : m.user_subscriptions_device_other({ count: sub.deviceLimit });

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle>{sub.planName}</CardTitle>
            <CardDescription>
              {formatDate(sub.startedAt)} – {formatDate(sub.expiresAt)}
            </CardDescription>
          </div>
          <SubscriptionStatusBadge status={effectiveStatus} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">
              {m.user_subscriptions_devices_label()}
            </span>
            <span>{deviceLabel}</span>
          </div>
        </div>

        <SubscriptionQuotaUsage
          trafficQuotaBytes={sub.trafficQuotaBytes}
          trafficUsedBytes={sub.trafficUsedBytes}
          size="sm"
        />

        <div className="mt-auto flex flex-col gap-2">
          <Button
            className="w-full"
            disabled={!usable}
            onClick={() => void handleCopy()}
            aria-describedby={!usable ? `copy-help-${sub.id}` : undefined}
          >
            <CopyIcon className="mr-2 size-4" />
            {m.user_subscriptions_copy_url()}
          </Button>
          {!usable && (
            <p
              id={`copy-help-${sub.id}`}
              className="text-xs text-muted-foreground"
            >
              {m.user_subscriptions_copy_disabled_help()}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
