import { Link, type LinkComponentProps } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

const statStripVariants = cva(
  "grid divide-y border-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-5",
  {
    defaultVariants: {
      columns: 5,
    },
    variants: {
      columns: {
        3: "xl:grid-cols-3",
        4: "xl:grid-cols-4",
        5: "xl:grid-cols-5",
      },
    },
  },
);

export interface StatStripProps
  extends
    Omit<ComponentProps<"div">, "children">,
    VariantProps<typeof statStripVariants> {
  children: ReactNode;
}

export function StatStrip({ className, columns, ...props }: StatStripProps) {
  return (
    <div
      className={cn(statStripVariants({ columns }), className)}
      data-slot="stat-strip"
      {...props}
    />
  );
}

const statStripItemClassName =
  "flex min-w-0 flex-col gap-1 px-4 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:ring-inset";

const statStripValueVariants = cva(
  "truncate text-lg font-semibold tabular-nums",
  {
    defaultVariants: {
      tone: "default",
    },
    variants: {
      tone: {
        default: "",
        warning: "text-warning-foreground",
      },
    },
  },
);

export interface StatStripItemProps {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: "default" | "warning";
  href?: LinkComponentProps["to"];
}

export function StatStripItem({
  label,
  value,
  detail,
  tone,
  href,
}: StatStripItemProps) {
  const content = (
    <>
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className={statStripValueVariants({ tone })}>{value}</span>
      {detail ? (
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        className={cn(
          statStripItemClassName,
          "transition-colors hover:bg-accent/50",
        )}
        data-slot="stat-strip-item"
        to={href}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className={statStripItemClassName} data-slot="stat-strip-item">
      {content}
    </div>
  );
}
