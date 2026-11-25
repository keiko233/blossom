import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Page chrome for a document pane. `PageHeader` must be a direct child of the
 * scroll viewport (`WorkspaceViewport` or `admin-viewport`) and never inside
 * `PageContent`, a card or any other padded wrapper: it is sticky and uses the
 * same horizontal padding as `PageContent` so the title and content align.
 */
export function PageHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex min-h-12 shrink-0 items-center justify-between gap-3",
        "border-b bg-background px-4 lg:px-6",
        className,
      )}
      data-slot="page-header"
      {...props}
    />
  );
}

export function PageHeaderTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      className={cn(
        "min-w-0 truncate font-heading text-lg font-semibold",
        className,
      )}
      data-slot="page-header-title"
      {...props}
    />
  );
}

export function PageHeaderDescription({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "hidden truncate text-xs text-muted-foreground md:block",
        className,
      )}
      data-slot="page-header-description"
      {...props}
    />
  );
}

export function PageHeaderActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 items-center gap-2", className)}
      data-slot="page-header-actions"
      {...props}
    />
  );
}

export function PageToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "sticky top-(--page-header-h) z-10 flex h-11 shrink-0 items-center gap-2",
        "border-b bg-background px-4 lg:px-6",
        className,
      )}
      data-slot="page-toolbar"
      {...props}
    />
  );
}

const pageContentVariants = cva(
  "flex min-w-0 flex-1 flex-col gap-4 p-4 lg:p-6",
  {
    defaultVariants: {
      width: "full",
    },
    variants: {
      width: {
        full: "",
        form: "mx-auto w-full max-w-3xl",
        flush: "gap-0 p-0 lg:p-0",
      },
    },
  },
);

export interface PageContentProps
  extends ComponentProps<"div">, VariantProps<typeof pageContentVariants> {}

export function PageContent({ className, width, ...props }: PageContentProps) {
  return (
    <div
      className={cn(pageContentVariants({ width }), className)}
      data-slot="page-content"
      {...props}
    />
  );
}

export function SectionHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-8 items-center justify-between gap-2",
        className,
      )}
      data-slot="section-header"
      {...props}
    />
  );
}

export function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("min-w-0 truncate text-sm font-semibold", className)}
      data-slot="section-title"
      {...props}
    />
  );
}

export function SectionActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 items-center gap-2", className)}
      data-slot="section-actions"
      {...props}
    />
  );
}
