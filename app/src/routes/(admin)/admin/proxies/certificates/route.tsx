import { createFileRoute, Outlet } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/proxies/certificates")({
  component: Outlet,
  staticData: {
    crumb: () => m.admin_certificates_title(),
  },
});
