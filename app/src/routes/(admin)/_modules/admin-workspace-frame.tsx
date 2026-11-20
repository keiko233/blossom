import { useLocation } from "@tanstack/react-router";
import type { PropsWithChildren, ReactElement } from "react";
import { useState } from "react";

import {
  Workspace,
  WorkspacePane,
  WorkspaceViewport,
} from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AdminWorkspaceSidebar } from "./admin-workspace-sidebar";
import type { AdminWorkspaceSection } from "./admin-workspace-sidebar";

export interface AdminWorkspaceFrameProps extends PropsWithChildren {
  title: string;
  sections: readonly AdminWorkspaceSection[];
}

/**
 * Two-pane workspace frame: a text context sidebar beside a single bounded
 * viewport. The scroll id includes the current pathname so Back restores the
 * same section and another section never inherits its position.
 */
export function AdminWorkspaceFrame({
  title,
  sections,
  children,
}: AdminWorkspaceFrameProps): ReactElement {
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarId = `workspace-sidebar-${pathname.replaceAll("/", "-")}`;

  return (
    <Workspace>
      <div className="border-b p-3 md:hidden">
        <Button
          variant="outline"
          size="sm"
          aria-expanded={sidebarOpen}
          aria-controls={sidebarId}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {title}
        </Button>
      </div>

      <AdminWorkspaceSidebar
        id={sidebarId}
        className={cn(sidebarOpen ? "flex" : "hidden", "md:flex")}
        title={title}
        sections={sections}
        onNavigate={() => setSidebarOpen(false)}
      />

      <WorkspacePane>
        <WorkspaceViewport
          scrollId={`workspace-${pathname}`}
          className="[&_[data-slot=page-header]]:sticky [&_[data-slot=page-header]]:top-0 [&_[data-slot=page-header]]:z-10 [&_[data-slot=page-header]]:bg-background"
        >
          {children}
        </WorkspaceViewport>
      </WorkspacePane>
    </Workspace>
  );
}
