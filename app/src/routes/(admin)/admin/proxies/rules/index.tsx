import { createFileRoute } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/proxies/rules/")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_rules(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/(admin)/admin/proxies/rules/"!</div>;
}
