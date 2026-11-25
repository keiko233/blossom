import type { ComponentProps, ReactNode } from "react";

import { PageContent, PageHeader } from "@/components/app-shell/page-header";
import {
  WorkbenchBar,
  WorkbenchBody,
  WorkbenchCanvas,
  WorkbenchRail,
  WorkbenchStatusBar,
  WorkbenchViewport,
} from "@/components/app-shell/workspace";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

const tableBarWidths = [
  "w-24",
  "w-32",
  "w-20",
  "w-28",
  "w-16",
  "w-24",
] as const;

function keyValueGridClasses(columns: 2 | 3): string {
  return cn(
    "grid gap-x-6 gap-y-4",
    columns === 3 ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2",
  );
}

function LoadingLabel({ className }: { className?: string }) {
  return (
    <span className={cn("sr-only", className)}>{m.admin_ui_loading()}</span>
  );
}

function TableSkeletonContent({
  columns,
  dense,
  rows,
}: {
  columns: number;
  dense: boolean;
  rows: number;
}) {
  const columnList = Array.from({ length: columns }, (_, index) => index);

  return (
    <>
      <div className="flex h-9 items-center gap-4 border-b px-4 lg:px-6">
        {columnList.map((column) => (
          <Skeleton
            key={column}
            className={cn(
              "h-3",
              tableBarWidths[(column * 2 + columns) % tableBarWidths.length],
            )}
          />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className={cn(
            "flex items-center gap-4 border-b px-4 lg:px-6",
            dense ? "h-9" : "h-10",
          )}
        >
          {columnList.map((column) => (
            <Skeleton
              key={column}
              className={cn(
                "h-4",
                tableBarWidths[(row + column * 3) % tableBarWidths.length],
                column === columns - 1 && "ms-auto",
              )}
            />
          ))}
        </div>
      ))}
    </>
  );
}

export interface TableSkeletonProps extends ComponentProps<"div"> {
  rows?: number;
  columns?: number;
  dense?: boolean;
}

export function TableSkeleton({
  rows = 8,
  columns = 5,
  dense = true,
  className,
  ...props
}: TableSkeletonProps) {
  const columnCount = Math.max(1, columns);
  const rowCount = Math.max(0, rows);

  return (
    <div
      className={cn("w-full", className)}
      data-slot="table-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      <TableSkeletonContent
        columns={columnCount}
        dense={dense}
        rows={rowCount}
      />
    </div>
  );
}

export function SidebarListSkeleton({
  rows = 8,
  className,
  ...props
}: ComponentProps<"div"> & { rows?: number }) {
  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      data-slot="sidebar-list-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      {Array.from({ length: Math.max(0, rows) }, (_, row) => (
        <div
          key={row}
          className="flex h-13 flex-col justify-center gap-1.5 px-2.5"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function KeyValueGridSkeleton({
  items = 6,
  columns = 2,
  className,
  ...props
}: ComponentProps<"div"> & { items?: number; columns?: 2 | 3 }) {
  return (
    <div
      className={cn(keyValueGridClasses(columns), className)}
      data-slot="key-value-grid-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      <KeyValueGridSkeletonContent items={items} />
    </div>
  );
}

function KeyValueGridSkeletonContent({ items = 6 }: { items?: number }) {
  return Array.from({ length: Math.max(0, items) }, (_, item) => (
    <div key={item} className="flex flex-col gap-2">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-4 w-32" />
    </div>
  ));
}

export function ChartSkeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-48 flex-col justify-between rounded-xl border p-4",
        className,
      )}
      data-slot="chart-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      <div className="flex justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="flex flex-1 items-end gap-2 py-4">
        <Skeleton className="h-full w-px shrink-0" />
        <Skeleton className="h-1/3 flex-1" />
        <Skeleton className="h-2/3 flex-1" />
        <Skeleton className="h-1/2 flex-1" />
        <Skeleton className="h-3/4 flex-1" />
        <Skeleton className="h-2/5 flex-1" />
        <Skeleton className="h-3/5 flex-1" />
        <Skeleton className="h-full w-px shrink-0" />
      </div>
      <div className="flex justify-between gap-4">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-2.5 w-16" />
      </div>
    </div>
  );
}

export function StatStripSkeleton({
  items = 4,
  className,
  ...props
}: ComponentProps<"div"> & { items?: number }) {
  return (
    <div
      className={cn(
        "grid divide-y border-y sm:grid-cols-2 sm:divide-x sm:divide-y-0",
        items >= 5 ? "xl:grid-cols-5" : "xl:grid-cols-4",
        className,
      )}
      data-slot="stat-strip-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      {Array.from({ length: Math.max(0, items) }, (_, item) => (
        <div key={item} className="flex flex-col gap-2 px-4 py-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-24" />
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton({
  fields = 6,
  className,
  ...props
}: ComponentProps<"div"> & { fields?: number }) {
  return (
    <div
      className={cn("flex flex-col gap-5", className)}
      data-slot="form-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      {Array.from({ length: Math.max(0, fields) }, (_, field) => (
        <div key={field} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

export function InspectorSkeleton({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-6 p-4", className)}
      data-slot="inspector-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      <Skeleton className="h-5 w-40" />
      <div className={keyValueGridClasses(2)}>
        <KeyValueGridSkeletonContent />
      </div>
      <div className="flex flex-col gap-3 border-t pt-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <div className="flex flex-col gap-3 border-t pt-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

export type WorkbenchSkeletonVariant = "terminal" | "logs" | "topology";

export function WorkbenchSkeleton({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & { variant: WorkbenchSkeletonVariant }) {
  return (
    <WorkbenchViewport
      className={cn("flex-1", className)}
      data-slot="workbench-skeleton"
      role="status"
      aria-busy="true"
      {...props}
    >
      <LoadingLabel />
      <WorkbenchBar aria-label={m.admin_ui_loading()}>
        {Array.from({ length: variant === "terminal" ? 3 : 5 }, (_, item) => (
          <Skeleton
            key={item}
            className={cn("h-7", item === 0 ? "w-28" : "w-16")}
          />
        ))}
        <Skeleton className="ms-auto h-7 w-20" />
      </WorkbenchBar>
      <WorkbenchBody>
        <WorkbenchCanvas className="p-2">
          <WorkbenchCanvasSkeleton variant={variant} />
        </WorkbenchCanvas>
        {variant === "topology" && (
          <WorkbenchRail>
            <InspectorSkeleton className="border-s-0" />
          </WorkbenchRail>
        )}
      </WorkbenchBody>
      <WorkbenchStatusBar>
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="ms-auto h-3 w-24" />
      </WorkbenchStatusBar>
    </WorkbenchViewport>
  );
}

function WorkbenchCanvasSkeleton({
  variant,
}: {
  variant: WorkbenchSkeletonVariant;
}) {
  if (variant === "terminal") {
    return <div className="h-full w-full rounded-lg bg-terminal" />;
  }

  if (variant === "logs") {
    return (
      <div className="flex h-full flex-col gap-3 overflow-hidden p-2 font-mono">
        {Array.from({ length: 18 }, (_, row) => (
          <Skeleton
            key={row}
            className={cn(
              "h-3",
              row % 3 === 0 ? "w-4/5" : row % 3 === 1 ? "w-full" : "w-3/5",
            )}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]">
      {[
        "top-6 left-6",
        "top-6 left-1/3",
        "top-1/3 left-1/2",
        "bottom-8 left-6",
        "bottom-1/4 left-2/3",
      ].map((position) => (
        <Skeleton
          key={position}
          className={cn(
            "absolute h-12 w-36 rounded-lg border border-border bg-card",
            position,
          )}
        />
      ))}
    </div>
  );
}

export interface PageSkeletonProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

export function PageSkeleton({
  children,
  className,
  ...props
}: PageSkeletonProps) {
  return (
    <div
      className={cn("[&>[data-slot=page-content]]:flex-1", className)}
      data-slot="page-skeleton"
      role="status"
      aria-busy="true"
      aria-label={m.admin_ui_loading()}
      {...props}
    >
      <PageHeader>
        <Skeleton className="h-5 w-40" />
      </PageHeader>
      <PageContent>
        <LoadingLabel />
        {children}
      </PageContent>
    </div>
  );
}
