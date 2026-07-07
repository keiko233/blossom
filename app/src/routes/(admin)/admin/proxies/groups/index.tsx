import { createFileRoute } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(admin)/admin/proxies/groups/")({
  staticData: {
    crumb: () => m.admin_nav_proxies_item_groups(),
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/(admin)/admin/proxies/groups/"!</div>;
}
