import type React from "react";

import { Badge } from "@/components/ui/badge";
import type {
  RoutingDiff,
  RoutingPreview,
  RoutingPreviewAction,
} from "@/lib/networking-workspace";
import { m } from "@/paraglide/messages";

import { NetworkingSection, RoutingActionBadge } from "./networking-badges";
import { NetworkingIssues } from "./networking-issues";

function matchText(action: RoutingPreviewAction): string {
  const parts: string[] = [];
  if (action.match.domains.length > 0)
    parts.push(
      m.admin_networking_routing_match_domains({
        values: action.match.domains.join(", "),
      }),
    );
  if (action.match.domainSuffixes.length > 0)
    parts.push(
      m.admin_networking_routing_match_suffixes({
        values: action.match.domainSuffixes.join(", "),
      }),
    );
  if (action.match.domainKeywords.length > 0)
    parts.push(
      m.admin_networking_routing_match_keywords({
        values: action.match.domainKeywords.join(", "),
      }),
    );
  if (action.match.ipCidrs.length > 0)
    parts.push(
      m.admin_networking_routing_match_cidrs({
        values: action.match.ipCidrs.join(", "),
      }),
    );
  if (action.match.ports.length > 0)
    parts.push(
      m.admin_networking_routing_match_ports({
        values: action.match.ports.join(", "),
      }),
    );
  if (action.match.ruleSetTags.length > 0)
    parts.push(
      m.admin_networking_routing_match_rule_sets({
        values: action.match.ruleSetTags.join(", "),
      }),
    );
  return parts.length > 0
    ? parts.join(" · ")
    : m.admin_networking_routing_match_everything();
}

function actionNote(action: RoutingPreviewAction): string | null {
  if (action.note === "peer_udp_reject")
    return m.admin_networking_routing_peer_udp_reject();
  if (action.note === "peer_default_reject")
    return m.admin_networking_routing_peer_default_reject();
  if (action.note === "final_fallback")
    return m.admin_networking_routing_final_fallback();
  return null;
}

export function RoutingPreviewPanel({
  preview,
  diff,
}: {
  preview: RoutingPreview;
  diff: RoutingDiff | null;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <NetworkingSection
        title={m.admin_networking_routing_effective_title()}
        description={m.admin_networking_routing_effective_description()}
      >
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">
            {m.admin_networking_routing_affected({
              count: preview.affectedInboundTags.length,
            })}
          </Badge>
          <Badge variant="outline">
            {m.admin_networking_routing_peer_dependencies({
              count: preview.peerOutboundTags.length,
            })}
          </Badge>
          <Badge variant="outline">
            {m.admin_networking_routing_rule_sets_used({
              count: preview.ruleSetTags.length,
            })}
          </Badge>
        </div>
        <ol className="flex flex-col gap-1.5">
          {preview.actions.map((action, index) => (
            <li
              key={action.key}
              className="flex flex-wrap items-start gap-2 rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <span className="w-6 shrink-0 text-end font-mono text-xs text-muted-foreground">
                {index + 1}
              </span>
              <RoutingActionBadge
                action={
                  action.action === "route"
                    ? action.origin === "fallback"
                      ? "fallback"
                      : "route"
                    : action.action === "reject"
                      ? "reject"
                      : action.action
                }
                network={action.network}
              />
              <span className="min-w-0 flex-1 break-words">
                <span className="font-mono text-xs">
                  {action.inboundTags.join(", ")}
                </span>
                <span className="ms-2">{matchText(action)}</span>
                {action.outboundTag ? (
                  <span className="ms-2 font-mono text-xs">
                    → {action.outboundTag}
                  </span>
                ) : null}
              </span>
              {actionNote(action) ? (
                <span className="w-full ps-8 text-xs text-muted-foreground">
                  {actionNote(action)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </NetworkingSection>

      <NetworkingIssues
        issues={preview.issues}
        title={m.admin_networking_routing_warnings_title()}
      />

      {diff ? (
        <NetworkingSection
          title={m.admin_networking_routing_diff_title()}
          description={m.admin_networking_routing_diff_description()}
        >
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <DiffCount
              label={m.admin_networking_routing_diff_added()}
              count={diff.addedRuleIds.length}
            />
            <DiffCount
              label={m.admin_networking_routing_diff_removed()}
              count={diff.removedRuleIds.length}
            />
            <DiffCount
              label={m.admin_networking_routing_diff_changed()}
              count={diff.changedRuleIds.length}
            />
            <DiffCount
              label={m.admin_networking_routing_diff_reordered()}
              count={diff.reordered ? 1 : 0}
            />
            <DiffCount
              label={m.admin_networking_routing_diff_final()}
              count={diff.finalOutboundChanged ? 1 : 0}
            />
            <DiffCount
              label={m.admin_networking_routing_diff_peer_added()}
              count={diff.peerOutboundTagsAdded.length}
            />
            <DiffCount
              label={m.admin_networking_routing_diff_peer_removed()}
              count={diff.peerOutboundTagsRemoved.length}
            />
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>
              {m.admin_networking_routing_diff_final_value({
                before: diff.previousFinalOutboundTag,
                after: diff.nextFinalOutboundTag,
              })}
            </span>
            {diff.affectedInboundTagsAdded.map((tag) => (
              <Badge key={`add-${tag}`} variant="success">
                + {tag}
              </Badge>
            ))}
            {diff.affectedInboundTagsRemoved.map((tag) => (
              <Badge key={`remove-${tag}`} variant="error">
                − {tag}
              </Badge>
            ))}
          </div>
        </NetworkingSection>
      ) : null}
    </div>
  );
}

function DiffCount({
  label,
  count,
}: {
  label: string;
  count: number;
}): React.ReactElement {
  return (
    <span className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{count}</span>
    </span>
  );
}
