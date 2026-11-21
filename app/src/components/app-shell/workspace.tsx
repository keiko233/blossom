import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Admin workspace layout: an optional context sidebar beside a pane with a
 * fixed header and a bounded content viewport. From `md` up the sidebar and
 * the viewport scroll independently inside the admin viewport; below `md` the
 * regions stack and scroll with the admin viewport as one column.
 *
 * Each page renders at most one `WorkspaceViewport`, because the router resets
 * it by selector on new navigations (see `WORKSPACE_SCROLL_TO_TOP_SELECTORS`).
 */

/** `data-scroll-restoration-id` of the admin shell's own scroll container. */
export const ADMIN_VIEWPORT_SCROLL_ID = "admin-viewport";

/**
 * Scroll containers the router resets on push navigation and restores on
 * Back. Context sidebars are left out so their scroll survives navigation.
 */
export const WORKSPACE_SCROLL_TO_TOP_SELECTORS: string[] = [
  `[data-scroll-restoration-id="${ADMIN_VIEWPORT_SCROLL_ID}"]`,
  '[data-slot="workspace-viewport"]',
];

export function Workspace({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        "md:grid md:min-h-0 md:flex-1",
        "md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]",
        className,
      )}
      data-slot="workspace"
      {...props}
    />
  );
}

export function WorkspaceSidebar({
  className,
  ...props
}: ComponentProps<"aside">) {
  return (
    <aside
      className={cn(
        "w-full flex-col border-b",
        "md:flex md:min-h-0 md:overflow-y-auto md:border-r md:border-b-0",
        className,
      )}
      data-slot="workspace-sidebar"
      {...props}
    />
  );
}

export function WorkspacePane({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 flex-col md:min-h-0", className)}
      data-slot="workspace-pane"
      {...props}
    />
  );
}

export function WorkspaceHeader({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-4", className)}
      data-slot="workspace-header"
      {...props}
    />
  );
}

export interface WorkspaceViewportProps extends ComponentProps<"div"> {
  /**
   * Scroll restoration id scoped to the route and resource (for example
   * `server-<id>`), so Back restores this resource's position and another
   * resource never inherits it.
   */
  scrollId: string;
}

export function WorkspaceViewport({
  scrollId,
  className,
  ...props
}: WorkspaceViewportProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        "md:min-h-0 md:flex-1 md:overflow-y-auto",
        className,
      )}
      data-slot="workspace-viewport"
      data-scroll-restoration-id={scrollId}
      {...props}
    />
  );
}
