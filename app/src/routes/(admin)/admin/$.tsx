import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import {
  filterLegacyAdminSearch,
  resolveLegacyAdminPath,
} from "@/lib/admin-workspace";
import { getNodeServerId } from "@/query/nodes";

/**
 * Compatibility matcher for pre-workspace admin URLs. Canonical routes win
 * over this splat, so it only sees paths that still need redirecting. The
 * admin role guard already runs in the parent `(admin)` layout.
 */
export const Route = createFileRoute("/(admin)/admin/$")({
  beforeLoad: async ({ location }) => {
    const destination = resolveLegacyAdminPath(location.pathname);
    if (!destination) {
      throw notFound();
    }

    const search = new URLSearchParams(location.searchStr);
    const query = new URLSearchParams(
      filterLegacyAdminSearch(
        destination.kind === "node" ? "/admin/servers" : destination.pathname,
        search,
      ),
    ).toString();

    if (destination.kind === "node") {
      let serverId: string;
      try {
        serverId = (await getNodeServerId({ data: { id: destination.nodeId } }))
          .serverId;
      } catch {
        throw redirect({ href: "/admin/servers" });
      }

      throw redirect({
        href: `/admin/servers/${serverId}/inbounds/${destination.nodeId}${
          query ? `?${query}` : ""
        }`,
      });
    }

    throw redirect({
      href: `${destination.pathname}${query ? `?${query}` : ""}`,
    });
  },
});
