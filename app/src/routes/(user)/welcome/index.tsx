import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleCheckIcon, InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RedeemCodeCard } from "@/components/redeem-code-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatDate } from "@/lib/format";
import { isSubscriptionActive } from "@/lib/subscription-helpers";
import { m } from "@/paraglide/messages";
import { currentUserQueryKey, getCurrentUser } from "@/query/current-user";

export const Route = createFileRoute("/(user)/welcome/")({
  component: RouteComponent,
});

/** Clients that understand Clash Meta (mihomo) subscription profiles. */
const COMPATIBLE_CLIENTS = [
  "Clash Verge Rev",
  "Clash Meta / mihomo-based clients",
  "FlClash",
] as const;

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
        <span className="sr-only">{m.welcome_loading()}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <Alert variant="error" className="max-w-md">
          <AlertTitle>{m.welcome_error_title()}</AlertTitle>
          <AlertDescription>{m.welcome_error_description()}</AlertDescription>
        </Alert>
        <Button loading={isFetching} onClick={() => void refetch()}>
          {m.welcome_error_retry()}
        </Button>
      </div>
    );
  }

  const activeSubscriptions = data.subscriptions.filter((sub) =>
    isSubscriptionActive(sub),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {m.welcome_title({ name: user.name })}
        </h1>
        <p className="text-muted-foreground">{m.welcome_description()}</p>
      </header>

      <Step number={1} title={m.welcome_step_access_title()}>
        <p className="text-sm text-muted-foreground">
          {m.welcome_step_access_description()}
        </p>

        {activeSubscriptions.length > 0 ? (
          <Alert variant="success">
            <CircleCheckIcon />
            <AlertTitle>{m.welcome_access_active_title()}</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              {activeSubscriptions.map((sub) => (
                <span key={sub.id}>
                  {m.welcome_access_active_description({
                    plan: sub.planName,
                    date: formatDate(sub.expiresAt),
                  })}
                </span>
              ))}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <RedeemCodeCard userId={user.id} />
            <p className="text-sm text-muted-foreground">
              {m.welcome_access_admin_note()}
            </p>
          </>
        )}
      </Step>

      <Step number={2} title={m.welcome_step_subscribe_title()}>
        <p className="text-sm text-muted-foreground">
          {m.welcome_step_subscribe_description()}
        </p>
        <div>
          <Button
            variant="outline"
            render={<Link to="/dashboard/subscriptions" />}
          >
            {m.welcome_step_subscribe_action()}
          </Button>
        </div>
      </Step>

      <Step number={3} title={m.welcome_step_client_title()}>
        <p className="text-sm text-muted-foreground">
          {m.welcome_step_client_description()}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {COMPATIBLE_CLIENTS.map((client) => (
            <li key={client}>{client}</li>
          ))}
        </ul>
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>{m.welcome_step_client_tip()}</AlertDescription>
        </Alert>
      </Step>

      <div className="flex justify-end">
        <Button size="lg" render={<Link to="/dashboard" />}>
          {m.welcome_go_dashboard()}
        </Button>
      </div>
    </div>
  );
}

interface StepProps {
  number: number;
  title: string;
  children: ReactNode;
}

/** One numbered onboarding step: a heading row, then its content. */
function Step({ number, title, children }: StepProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
        >
          {number}
        </span>
        <h2 className="text-lg font-semibold">
          <span className="sr-only">
            {m.welcome_step_label({ step: number })}:{" "}
          </span>
          {title}
        </h2>
      </div>
      <div className="flex flex-col gap-4 pl-11">{children}</div>
    </section>
  );
}
