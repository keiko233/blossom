import { createFileRoute } from "@tanstack/react-router";
import type React from "react";

import { m } from "@/paraglide/messages";

import { ServerOnboardingPage } from "./_modules/server-onboarding-page";

export const Route = createFileRoute("/(admin)/admin/servers/new")({
  staticData: {
    crumb: () => m.admin_proxies_servers_form_create_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  return <ServerOnboardingPage />;
}
