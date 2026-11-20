import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { ReactNode } from "react";

import { WORKSPACE_SCROLL_TO_TOP_SELECTORS } from "./components/app-shell/workspace";
import { getContext } from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./route-tree.gen";

export function getRouter() {
  const context = getContext();

  const router = createTanStackRouter({
    routeTree,
    context,
    scrollRestoration: true,
    scrollToTopSelectors: WORKSPACE_SCROLL_TO_TOP_SELECTORS,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }

  interface StaticDataRouteOption {
    /**
     * Breadcrumb label for this route. Called during render so that
     * paraglide messages stay reactive to the current locale.
     */
    crumb?: () => ReactNode;
  }
}
