import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { FormSkeleton } from "@/components/app-shell/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { ADMIN_SETTINGS_QUERY_KEY, getAdminSettings } from "@/query/settings";

import { RegistrationCard } from "./_modules/registration-card";
import { SiteCard } from "./_modules/site-card";
import { SubscriptionOutputCard } from "./_modules/subscription-output-card";
import { SystemStatusCard } from "./_modules/system-status-card";
import { TrialCard } from "./_modules/trial-card";

export const Route = createFileRoute("/(admin)/admin/operations/settings/")({
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
    <>
      <PageHeader>
        <div className="flex min-w-0 items-baseline gap-3">
          <PageHeaderTitle>{m.admin_settings_title()}</PageHeaderTitle>
          <PageHeaderDescription className="hidden lg:block">
            {m.admin_settings_description()}
          </PageHeaderDescription>
        </div>
      </PageHeader>

      <PageContent>
        <div className="grid gap-8 xl:grid-cols-[12rem_minmax(0,44rem)] xl:items-start">
          <nav
            aria-label={m.admin_page_settings_sections()}
            className="hidden xl:block"
          >
            <ul className="sticky top-(--page-header-h) flex flex-col gap-1 pt-1">
              {SETTINGS_SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    className="block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:outline-none"
                    href={`#${section.id}`}
                  >
                    {section.label()}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-6">
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

            {isPending ? <FormSkeleton fields={8} /> : null}

            {data ? (
              <>
                <SiteCard saved={data.settings.site} />
                <RegistrationCard saved={data.settings.registration} />
                <TrialCard saved={data.settings.trial} />
                <SubscriptionOutputCard
                  saved={data.settings.subscription_output}
                />
                <SystemStatusCard status={data.status} />
              </>
            ) : null}
          </div>
        </div>
      </PageContent>
    </>
  );
}

const SETTINGS_SECTIONS = [
  { id: "settings-site", label: m.admin_settings_site_title },
  { id: "settings-registration", label: m.admin_settings_registration_title },
  { id: "settings-trial", label: m.admin_settings_trial_title },
  {
    id: "settings-subscription-output",
    label: m.admin_settings_output_title,
  },
  { id: "settings-status", label: m.admin_settings_status_title },
] as const;
