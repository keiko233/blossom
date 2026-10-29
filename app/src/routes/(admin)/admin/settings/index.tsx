import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";
import { ADMIN_SETTINGS_QUERY_KEY, getAdminSettings } from "@/query/settings";

import { RegistrationCard } from "./_modules/registration-card";
import { SiteCard } from "./_modules/site-card";
import { SubscriptionOutputCard } from "./_modules/subscription-output-card";
import { SystemStatusCard } from "./_modules/system-status-card";
import { TrialCard } from "./_modules/trial-card";

export const Route = createFileRoute("/(admin)/admin/settings/")({
  staticData: {
    crumb: () => m.admin_nav_settings(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ADMIN_SETTINGS_QUERY_KEY,
    queryFn: () => getAdminSettings(),
  });

  return (
    <div className="flex flex-col">
      <PageHeader className="gap-3 border-b px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <PageHeaderTitle>{m.admin_settings_title()}</PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_settings_description()}
          </p>
        </div>
      </PageHeader>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {isError ? (
          <Alert variant="error">
            <AlertDescription className="flex items-center justify-between gap-3">
              {m.admin_settings_load_error()}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
              >
                {m.admin_settings_load_retry()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {isPending ? (
          <>
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </>
        ) : null}

        {data ? (
          <>
            <RegistrationCard saved={data.settings.registration} />
            <TrialCard saved={data.settings.trial} />
            <SubscriptionOutputCard saved={data.settings.subscription_output} />
            <SiteCard saved={data.settings.site} />
            <SystemStatusCard status={data.status} />
          </>
        ) : null}
      </div>
    </div>
  );
}
