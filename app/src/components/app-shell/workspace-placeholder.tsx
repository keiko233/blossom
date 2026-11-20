import type { ReactNode } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export interface WorkspacePlaceholderProps {
  title: string;
  description: string;
  actions?: ReactNode;
  children?: ReactNode;
}

/** Honest placeholder for a section whose managed data contract is not live. */
export function WorkspacePlaceholder({
  title,
  description,
  actions,
  children,
}: WorkspacePlaceholderProps) {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader>
        <PageHeaderTitle>{title}</PageHeaderTitle>
        {actions}
      </PageHeader>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {children}
      </Empty>
    </div>
  );
}
