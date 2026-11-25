import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Admin workspace layout: an optional context sidebar beside a pane. A
 * document pane uses `WorkspaceViewport` as its single scroller; a workbench
 * pane uses `WorkbenchViewport` and lets the tool own all scrolling. From `md`
 * up the sidebar and the pane scroll independently inside the admin viewport;
 * below `md` they stack and scroll with the admin viewport as one column.
 *
 * Each page renders at most one `WorkspaceViewport`, because the router resets
 * it by selector on new navigations (see `WORKSPACE_SCROLL_TO_TOP_SELECTORS`).
 * Never nest vertical scrollers: use split columns such as `WorkbenchRail` or
 * `WorkbenchBody` instead.
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
      className={cn("shrink-0 border-b bg-background", className)}
      data-slot="workspace-header"
      {...props}
    />
  );
}

export function WorkspaceTabBar({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-stretch gap-1 border-b bg-background px-2",
        className,
      )}
      data-slot="workspace-tab-bar"
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
        "[--page-header-h:3rem] [--page-toolbar-h:2.75rem]",
        className,
      )}
      data-slot="workspace-viewport"
      data-scroll-restoration-id={scrollId}
      {...props}
    />
  );
}

export function WorkbenchViewport({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        "max-md:h-(--workbench-mobile-h)",
        className,
      )}
      data-slot="workbench-viewport"
      {...props}
    />
  );
}

const workbenchBarVariants = cva(
  "flex shrink-0 items-center gap-1.5 border-b bg-background px-2",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "h-10",
        compact: "h-9",
      },
    },
  },
);

export interface WorkbenchBarProps
  extends ComponentProps<"div">, VariantProps<typeof workbenchBarVariants> {}

export function WorkbenchBar({ className, size, ...props }: WorkbenchBarProps) {
  return (
    <div
      className={cn(workbenchBarVariants({ size }), className)}
      data-slot="workbench-bar"
      role="toolbar"
      {...props}
    />
  );
}

export function WorkbenchBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1", className)}
      data-slot="workbench-body"
      {...props}
    />
  );
}

export function WorkbenchCanvas({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 min-w-0 flex-1 overflow-hidden",
        className,
      )}
      data-slot="workbench-canvas"
      {...props}
    />
  );
}

export function WorkbenchRail({
  className,
  ...props
}: ComponentProps<"aside">) {
  return (
    <aside
      className={cn(
        "hidden w-88 shrink-0 flex-col overflow-y-auto border-s bg-background lg:flex",
        className,
      )}
      data-slot="workbench-rail"
      {...props}
    />
  );
}

export function WorkbenchStatusBar({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-3 border-t bg-muted/30 px-3",
        "font-mono text-xs text-muted-foreground tabular-nums",
        className,
      )}
      data-slot="workbench-status-bar"
      {...props}
    />
  );
}
