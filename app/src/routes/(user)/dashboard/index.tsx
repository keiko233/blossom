import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import {
  SubscriptionQuotaUsage,
  SubscriptionTrafficTable,
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
import { formatDate } from "@/lib/format";
import { isSubscriptionActive } from "@/lib/subscription-helpers";
import { m } from "@/paraglide/messages";
import { currentUserQueryKey, getCurrentUser } from "@/query/current-user";

export const Route = createFileRoute("/(user)/dashboard/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { user } = Route.useRouteContext();

  const { data, isFetching, isPending, error, refetch } = useQuery({
    queryKey: currentUserQueryKey(user.id),
    queryFn: () => getCurrentUser(),
  });

  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
        <span className="sr-only">{m.user_dashboard_loading()}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <Alert variant="error" className="max-w-md">
          <AlertTitle>{m.user_dashboard_error()}</AlertTitle>
          <AlertDescription>{m.user_dashboard_error()}</AlertDescription>
        </Alert>
        <Button loading={isFetching} onClick={() => void refetch()}>
          {m.user_dashboard_error_retry()}
        </Button>
      </div>
    );
  }

  const { subscriptions, trafficRecords } = data;
  const activeSubscriptions = subscriptions.filter((sub) =>
    isSubscriptionActive(sub),
  );

  if (subscriptions.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.user_dashboard_no_subscriptions_title()}</EmptyTitle>
          <EmptyDescription>
            {m.user_dashboard_no_subscriptions_description()}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <PageHeader>
        <PageHeaderTitle className="text-2xl">
          {m.user_dashboard_title()}
        </PageHeaderTitle>
      </PageHeader>

      {activeSubscriptions.length === 0 && (
        <Alert>
          <AlertTriangleIcon className="h-4 w-4" />
          <AlertTitle>
            {m.user_dashboard_subscriptions_no_active_title()}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            {m.user_dashboard_subscriptions_no_active_description()}
            <Button
              variant="outline"
              className="w-fit"
              render={<Link to="/dashboard/subscriptions" />}
            >
              {m.user_dashboard_subscriptions_no_active_action()}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeSubscriptions.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="font-heading text-base font-semibold">
            {m.user_dashboard_subscriptions_title()}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeSubscriptions.map((sub) => (
              <Card key={sub.id}>
                <CardHeader>
                  <CardTitle>{sub.planName}</CardTitle>
                  <CardDescription>
                    {m.user_dashboard_expires_label()}:{" "}
                    {formatDate(sub.expiresAt)}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <SubscriptionQuotaUsage
                    trafficQuotaBytes={sub.trafficQuotaBytes}
                    trafficUsedBytes={sub.trafficUsedBytes}
                    size="sm"
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="font-heading text-base font-semibold">
          {m.user_dashboard_traffic_title()}
        </h2>
        <SubscriptionTrafficTable records={trafficRecords} />
      </div>
    </div>
  );
}
