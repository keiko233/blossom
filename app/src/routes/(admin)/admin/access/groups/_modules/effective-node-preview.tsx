import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import type React from "react";

import { NodeHealthBadge } from "@/components/node-health-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { EffectiveNodePreview } from "@/lib/access-impact";
import { m } from "@/paraglide/messages";

export interface EffectiveNodePreviewPanelProps {
  /** Undefined while the node (and group) lists are loading. */
  preview: EffectiveNodePreview | undefined;
  isError?: boolean;
  /** Group names by id, to say which group reaches a node. */
  groupNames?: ReadonlyMap<string, string>;
  /** Shown when nothing is selected yet. */
  emptyMessage: string;
  /** Shown when a selection resolves to no nodes at all. */
  noNodesMessage?: string;
  hasSelection: boolean;
}

/**
 * The unique nodes a selection resolves to, with the server, protocol and the
 * agent-reported state of each. It deliberately avoids "usable" wording: the
 * state is the agent's last report, and a node that was just added to a group
 * is withheld from existing subscriptions until the agent applies it.
 */
export function EffectiveNodePreviewPanel({
  preview,
  isError,
  groupNames,
  emptyMessage,
  noNodesMessage,
  hasSelection,
}: EffectiveNodePreviewPanelProps): React.ReactElement {
  return (
    <section
      aria-label={m.admin_access_preview_title()}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{m.admin_access_preview_title()}</h2>
        {preview ? (
          <span className="text-xs text-muted-foreground">
            {m.admin_access_preview_count({ count: preview.nodes.length })}
          </span>
        ) : null}
      </div>

      {isError ? (
        <p className="text-sm text-destructive">
          {m.admin_access_preview_error()}
        </p>
      ) : !preview ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : (
        <>
          {preview.nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {hasSelection ? (noNodesMessage ?? emptyMessage) : emptyMessage}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {preview.nodes.map(({ node, health, filtered, groupIds }) => (
                <li
                  key={node.id}
                  className="flex flex-col gap-1 rounded-lg border bg-muted/20 p-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      className="min-w-0 truncate text-sm font-medium underline-offset-4 hover:underline"
                      params={{
                        serverId: node.serverSummary.id,
                        nodeId: node.id,
                      }}
                      to="/admin/servers/$serverId/inbounds/$nodeId"
                    >
                      {node.name}
                    </Link>
                    <Badge variant="outline">{node.protocol}</Badge>
                    <NodeHealthBadge health={health} />
                    {filtered ? (
                      <span className="text-xs text-muted-foreground">
                        {m.admin_access_preview_withheld()}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <Link
                      className="underline-offset-4 hover:underline"
                      params={{ serverId: node.serverSummary.id }}
                      to="/admin/servers/$serverId/overview"
                    >
                      {node.serverSummary.name}
                    </Link>
                    <span className="font-mono">
                      {node.resolvedAddress}:{node.listenPort}
                    </span>
                    {groupNames && groupIds.length > 0 ? (
                      <span>
                        {m.admin_access_preview_via({
                          groups: groupIds
                            .map((id) => groupNames.get(id) ?? id)
                            .join(", "),
                        })}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <PreviewWarnings groupNames={groupNames} preview={preview} />
          <p className="text-xs text-muted-foreground">
            {m.admin_access_preview_note()}
          </p>
        </>
      )}
    </section>
  );
}

function PreviewWarnings({
  preview,
  groupNames,
}: {
  preview: EffectiveNodePreview;
  groupNames?: ReadonlyMap<string, string>;
}): React.ReactElement | null {
  const warnings: string[] = [];
  if (preview.filteredCount > 0) {
    warnings.push(
      m.admin_access_preview_filtered({ count: preview.filteredCount }),
    );
  }
  if (preview.needsAttentionCount > 0) {
    warnings.push(
      m.admin_access_preview_attention({ count: preview.needsAttentionCount }),
    );
  }
  if (preview.emptyGroupIds.length > 0) {
    warnings.push(
      m.admin_access_preview_empty_groups({
        names: preview.emptyGroupIds
          .map((id) => groupNames?.get(id) ?? id)
          .join(", "),
      }),
    );
  }
  if (preview.missingNodeIds.length > 0) {
    warnings.push(
      m.admin_access_preview_missing({ count: preview.missingNodeIds.length }),
    );
  }
  if (preview.unknownGroupIds.length > 0) {
    warnings.push(
      m.admin_access_preview_unknown_groups({
        count: preview.unknownGroupIds.length,
      }),
    );
  }
  if (warnings.length === 0) return null;

  return (
    <Alert role="status" variant="warning">
      <AlertTriangleIcon />
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
