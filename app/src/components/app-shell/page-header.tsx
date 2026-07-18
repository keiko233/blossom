import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function PageHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      data-slot="page-header"
      {...props}
    />
  );
}

export function PageHeaderTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      className={cn("font-heading text-lg font-semibold", className)}
      data-slot="page-header-title"
      {...props}
    />
  );
}
