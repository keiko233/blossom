import { Link, useLocation, type LinkProps } from "@tanstack/react-router";
import { cva } from "class-variance-authority";
import type React from "react";

import { WorkspaceSidebar } from "@/components/app-shell/workspace";
import { cn } from "@/lib/utils";

const sectionLinkVariants = cva([
  "flex min-w-0 items-center rounded-md px-3 py-2",
  "text-sm text-muted-foreground outline-none transition-colors",
  "hover:bg-accent hover:text-accent-foreground",
  "focus-visible:ring-[3px] focus-visible:ring-ring/24",
  "aria-[current=page]:bg-accent aria-[current=page]:font-medium",
  "aria-[current=page]:text-accent-foreground",
]);

export interface AdminWorkspaceSection {
  href: LinkProps["to"];
  label: string;
  /** Show this section as current for nested resource routes too. */
  prefix?: string;
}

export interface AdminWorkspaceSidebarProps {
  title: string;
  sections: readonly AdminWorkspaceSection[];
  id?: string;
  className?: string;
  /** Runs after a choice is made, so a narrow layout can close the sidebar. */
  onNavigate?: () => void;
}

/**
 * Text navigation for the active admin workspace. It owns its own scroll
 * while the workspace viewport scrolls independently beside it.
 */
export function AdminWorkspaceSidebar({
  title,
  sections,
  id = "admin-workspace-sidebar",
  className,
  onNavigate,
}: AdminWorkspaceSidebarProps): React.ReactElement {
  const { pathname } = useLocation();

  return (
    <WorkspaceSidebar
      id={id}
      data-slot="admin-workspace-sidebar"
      className={cn("gap-3 p-4", className)}
    >
      <h2 className="px-3 text-sm font-semibold">{title}</h2>
      <nav aria-label={title} className="flex min-h-0 flex-col overflow-y-auto">
        <ul className="flex flex-col gap-1">
          {sections.map((section) => {
            const active =
              pathname === section.href ||
              Boolean(
                section.prefix &&
                (pathname === section.prefix ||
                  pathname.startsWith(`${section.prefix}/`)),
              );

            return (
              <li key={section.href}>
                <Link
                  to={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(sectionLinkVariants())}
                  onClick={onNavigate}
                >
                  <span className="truncate">{section.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </WorkspaceSidebar>
  );
}
