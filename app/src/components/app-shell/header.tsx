import { type PropsWithChildren } from "react";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function AppShellHeader({ children }: PropsWithChildren) {
  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center gap-2",
        "border-b border-border",
        "transition-[width,height] ease-linear",
        "group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
      )}
    >
      <div className="flex items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />

        <Separator orientation="vertical" className="h-4" />

        {children}
      </div>
    </header>
  );
}
