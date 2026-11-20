import { CircleAlertIcon } from "lucide-react";
import type React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { NetworkingIssue } from "@/lib/networking-schema";
import { m } from "@/paraglide/messages";

import { networkingIssueMessage } from "./networking-issue-message";

export function NetworkingIssues({
  issues,
  title = m.admin_networking_issue_title(),
  emptyMessage,
}: {
  issues: readonly NetworkingIssue[];
  title?: string;
  emptyMessage?: string;
}): React.ReactElement | null {
  if (issues.length === 0) {
    return emptyMessage ? (
      <p className="text-sm text-muted-foreground">{emptyMessage}</p>
    ) : null;
  }
  return (
    <Alert variant="warning" data-slot="networking-issues">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 ps-4">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.subjectId ?? index}-${index}`}>
              {networkingIssueMessage(issue)}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
