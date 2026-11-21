import { cva } from "class-variance-authority";
import { ArrowDownLeftIcon, ArrowUpRightIcon, ServerIcon } from "lucide-react";
import type React from "react";
import { useId, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import {
  isSameSelection,
  linkHealthTone,
  linkPhaseTone,
  moveTopologySelection,
  topologySelectionOrder,
  type TopologyLinkHealth,
  type TopologyLinkPhase,
  type TopologyList as TopologyListModel,
  type TopologyListLink,
  type TopologyMove,
  type TopologySelection,
} from "@/lib/networking-topology";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export interface TopologyListProps {
  list: TopologyListModel;
  /** Whether a search is active, to tell an empty topology from no matches. */
  filtered: boolean;
  selection: TopologySelection | null;
  onSelectionChange: (selection: TopologySelection) => void;
  className?: string;
}

const MOVE_KEYS: Partial<Record<string, TopologyMove>> = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
};

const PHASE_LABEL: Record<TopologyLinkPhase, () => string> = {
  draft: m.admin_networking_link_phase_draft,
  pending: m.admin_networking_link_phase_pending,
  applying: m.admin_networking_link_phase_applying,
  stalled: m.admin_networking_link_phase_stalled,
  failed: m.admin_networking_link_phase_failed,
  applied: m.admin_networking_link_phase_applied,
  removing: m.admin_networking_link_phase_removing,
};

const HEALTH_LABEL: Record<TopologyLinkHealth, () => string> = {
  unknown: m.admin_networking_link_health_unknown,
  healthy: m.admin_networking_link_health_healthy,
  degraded: m.admin_networking_link_health_degraded,
};

function itemKey(selection: TopologySelection): string {
  return `${selection.kind}:${selection.id}`;
}

/**
 * Keyboard-accessible list equivalent of the topology canvas. Servers and
 * their outgoing links are selectable with one roving tab stop; incoming links
 * are summaries, selectable under their source server. Selection is owned by
 * the caller so the canvas and inspector can share it. Edit actions are not
 * rendered here; they belong in the inspector once rollout wiring lands.
 */
export function TopologyList({
  list,
  filtered,
  selection,
  onSelectionChange,
  className,
}: TopologyListProps): React.ReactElement {
  const hintId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const tabStop = selection ?? topologySelectionOrder(list.servers)[0] ?? null;

  const select = (next: TopologySelection) => {
    listRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-topology-item="${CSS.escape(itemKey(next))}"]`,
      )
      ?.focus();
    onSelectionChange(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const move = MOVE_KEYS[event.key];
    if (!move) return;
    const next = moveTopologySelection(list.servers, selection, move);
    if (!next) return;
    event.preventDefault();
    select(next);
  };

  const itemProps = (item: TopologySelection) => ({
    type: "button" as const,
    "data-topology-item": itemKey(item),
    "aria-current": isSameSelection(item, selection)
      ? ("true" as const)
      : undefined,
    tabIndex: isSameSelection(item, tabStop) ? 0 : -1,
    onClick: () => select(item),
  });

  if (list.servers.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        {filtered
          ? m.admin_networking_topology_no_match()
          : m.admin_networking_topology_empty()}
      </p>
    );
  }

  return (
    <div
      data-slot="topology-list"
      className={cn("flex flex-col gap-3", className)}
    >
      <p id={hintId} className="sr-only">
        {m.admin_networking_topology_list_hint()}
      </p>
      {list.unresolvedLinkIds.length > 0 ? (
        <p role="status" className="text-sm text-warning-foreground">
          {m.admin_networking_topology_unresolved({
            count: list.unresolvedLinkIds.length,
          })}
        </p>
      ) : null}

      <ul
        ref={listRef}
        aria-label={m.admin_networking_topology_list_label()}
        aria-describedby={hintId}
        className="flex flex-col gap-2"
        onKeyDown={handleKeyDown}
      >
        {list.servers.map((server) => (
          <li
            key={server.id}
            data-slot="topology-list-server"
            className="flex flex-col gap-1 rounded-lg border p-2"
          >
            <button
              {...itemProps({ kind: "server", id: server.id })}
              className={topologyItemVariants()}
            >
              <ServerIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {server.name}
              </span>
              {server.enabled ? null : (
                <Badge variant="secondary">
                  {m.admin_networking_topology_server_disabled()}
                </Badge>
              )}
            </button>

            {server.outgoing.length === 0 && server.incoming.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                {m.admin_networking_topology_isolated()}
              </p>
            ) : null}
            <TopologyLinkGroup
              label={m.admin_networking_topology_outgoing()}
              links={server.outgoing}
              renderLink={(link) => (
                <button
                  {...itemProps({ kind: "link", id: link.id })}
                  className={topologyItemVariants({ className: "flex-wrap" })}
                >
                  <TopologyLinkSummary link={link} />
                </button>
              )}
            />
            <TopologyLinkGroup
              label={m.admin_networking_topology_incoming()}
              links={server.incoming}
              renderLink={(link) => (
                <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-sm">
                  <TopologyLinkSummary link={link} />
                </div>
              )}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

const topologyItemVariants = cva([
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm",
  "outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/24",
  "aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground",
]);

function TopologyLinkGroup({
  label,
  links,
  renderLink,
}: {
  label: string;
  links: TopologyListLink[];
  renderLink: (link: TopologyListLink) => React.ReactNode;
}): React.ReactElement | null {
  if (links.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-col">
      <h3 className="px-2 text-xs text-muted-foreground">{label}</h3>
      <ul className="flex flex-col">
        {links.map((link) => (
          <li key={link.id}>{renderLink(link)}</li>
        ))}
      </ul>
    </section>
  );
}

function TopologyLinkSummary({
  link,
}: {
  link: TopologyListLink;
}): React.ReactElement {
  const Icon =
    link.direction === "outgoing" ? ArrowUpRightIcon : ArrowDownLeftIcon;
  const label =
    link.direction === "outgoing"
      ? m.admin_networking_topology_link_to({
          server: link.peerServerName,
          inbound: link.inboundName,
        })
      : m.admin_networking_topology_link_from({
          server: link.peerServerName,
          inbound: link.inboundName,
        });

  return (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words">{label}</span>
      <span className="flex shrink-0 gap-1">
        <Badge variant={linkPhaseTone(link.phase)}>
          {PHASE_LABEL[link.phase]()}
        </Badge>
        <Badge variant={linkHealthTone(link.health)}>
          {HEALTH_LABEL[link.health]()}
        </Badge>
      </span>
    </>
  );
}
