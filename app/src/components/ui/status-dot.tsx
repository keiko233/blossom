import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const statusDotVariants = cva("size-2 shrink-0 rounded-full", {
  defaultVariants: {
    tone: "muted",
  },
  variants: {
    tone: {
      success: "bg-success",
      warning: "bg-warning",
      info: "bg-info",
      danger: "bg-destructive",
      muted: "bg-muted-foreground/64",
    },
  },
});

export interface StatusDotProps
  extends
    Omit<ComponentProps<"span">, "children">,
    VariantProps<typeof statusDotVariants> {
  /** Adds the pulse animation for transitional states such as connecting. */
  pulse?: boolean;
  /** Accessible name. Without it the dot is decorative and hidden from AT. */
  label?: string;
}

export function StatusDot({
  className,
  tone,
  pulse,
  label,
  ...props
}: StatusDotProps) {
  return (
    <span
      className={cn(
        statusDotVariants({ tone }),
        pulse && "motion-safe:animate-pulse",
        className,
      )}
      data-slot="status-dot"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...props}
    />
  );
}
