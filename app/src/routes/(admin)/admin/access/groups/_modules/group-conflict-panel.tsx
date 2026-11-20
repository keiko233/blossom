import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import type React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { diffMembershipOrder } from "@/lib/group-membership-draft";
import { m } from "@/paraglide/messages";
import type { NodeListItem } from "@/query/nodes";

import type { GroupRevisionConflictState } from "./use-group-form";

export interface GroupConflictPanelProps {
  conflict: GroupRevisionConflictState;
  /** The order currently in the form, preserved across a reload. */
  draftNodeIds: readonly string[];
  nodes: readonly NodeListItem[];
  onReloadKeepingDraft: () => void;
  onUseSavedOrder: () => void;
  onRetry: () => void;
}

function nameFor(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? id;
}

function namesFor(ids: readonly string[], names: ReadonlyMap<string, string>) {
  return ids.map((id) => nameFor(id, names)).join(", ");
}

/**
 * Stale-revision comparison shown after a rejected ordered save. The latest
 * saved order is read-only comparison material; the draft stays in TanStack
 * Form until the operator chooses to adopt the saved membership.
 */
export function GroupConflictPanel({
  conflict,
  draftNodeIds,
  nodes,
  onReloadKeepingDraft,
  onUseSavedOrder,
  onRetry,
}: GroupConflictPanelProps): React.ReactElement {
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const latest = conflict.latest;
  const diff = latest
    ? diffMembershipOrder(latest.nodeIds, draftNodeIds)
    : { added: [], removed: [], moved: [] };
  const hasChanges =
    diff.added.length > 0 || diff.removed.length > 0 || diff.moved.length > 0;

  return (
    <Alert data-slot="group-conflict-panel" role="status" variant="warning">
      <AlertTriangleIcon />
      <AlertTitle>{m.admin_proxies_groups_conflict_title()}</AlertTitle>
      <AlertDescription>
        <p>
          {m.admin_proxies_groups_conflict_description({
            expected: conflict.expectedRevision,
            current: conflict.currentRevision,
          })}
        </p>

        {conflict.isPending ? (
          <div className="flex items-center gap-2">
            <Spinner />
            <span>{m.admin_proxies_groups_conflict_loading()}</span>
          </div>
        ) : conflict.loadFailed || !latest ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-destructive">
              {m.admin_proxies_groups_conflict_load_failed()}
            </p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              {m.admin_proxies_groups_conflict_retry()}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              render={<Link to="/admin/access/groups" />}
            >
              {m.admin_proxies_groups_form_back()}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              {hasChanges ? (
                <>
                  {diff.added.length > 0 ? (
                    <p>
                      {m.admin_proxies_groups_conflict_added({
                        names: namesFor(diff.added, names),
                      })}
                    </p>
                  ) : null}
                  {diff.removed.length > 0 ? (
                    <p>
                      {m.admin_proxies_groups_conflict_removed({
                        names: namesFor(diff.removed, names),
                      })}
                    </p>
                  ) : null}
                  {diff.moved.length > 0 ? (
                    <p>
                      {m.admin_proxies_groups_conflict_moved({
                        names: namesFor(diff.moved, names),
                      })}
                    </p>
                  ) : null}
                </>
              ) : (
                <p>{m.admin_proxies_groups_conflict_order_same()}</p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <span className="font-medium">
                {m.admin_proxies_groups_conflict_saved_order()}
              </span>
              <ol className="flex flex-wrap gap-x-3 gap-y-1 ps-4 text-xs">
                {latest.nodeIds.map((id, index) => (
                  <li key={id} className="list-decimal">
                    {nameFor(id, names)}
                    <span className="text-muted-foreground">
                      {" "}
                      ({index + 1})
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <p>{m.admin_proxies_groups_conflict_draft_kept()}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onReloadKeepingDraft}>
                {m.admin_proxies_groups_conflict_reload_keep()}
              </Button>
              <Button size="sm" variant="outline" onClick={onUseSavedOrder}>
                {m.admin_proxies_groups_conflict_use_saved()}
              </Button>
            </div>
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
