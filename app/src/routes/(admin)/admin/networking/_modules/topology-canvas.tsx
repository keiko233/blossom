import { ArrowDownLeftIcon, ArrowUpRightIcon, ServerIcon } from "lucide-react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import {
  linkHealthTone,
  linkPhaseTone,
  type TopologyLinkPhase,
  type TopologyLinkHealth,
  type TopologyList as TopologyListModel,
  type TopologySelection,
} from "@/lib/networking-topology";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

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

function isSelected(
  selection: TopologySelection | null,
  kind: "server" | "link",
  id: string,
): boolean {
  return selection?.kind === kind && selection.id === id;
}

export function TopologyCanvas({
  list,
  selection,
  onSelection,
}: {
  list: TopologyListModel;
  selection: TopologySelection | null;
  onSelection: (selection: TopologySelection) => void;
}): React.ReactElement {
  if (list.servers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {m.admin_networking_topology_empty()}
      </p>
    );
  }

  return (
    <ul
      aria-label={m.admin_networking_topology_canvas_label()}
      className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
    >
      {list.servers.map((server) => (
        <li key={server.id}>
          <article
            data-slot="topology-server-card"
            className={cn(
              "flex h-full flex-col gap-2 rounded-xl border bg-card p-3 shadow-xs",
              isSelected(selection, "server", server.id) &&
                "border-primary ring-2 ring-primary/20",
            )}
          >
            <button
              type="button"
              onClick={() => onSelection({ kind: "server", id: server.id })}
              aria-pressed={isSelected(selection, "server", server.id)}
              className="flex min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
            >
              <ServerIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {server.name}
              </span>
              {server.enabled ? (
                <Badge variant="outline">
                  {m.admin_networking_topology_enabled()}
                </Badge>
              ) : (
                <Badge variant="warning">
                  {m.admin_networking_topology_server_disabled()}
                </Badge>
              )}
            </button>

            {server.outgoing.length === 0 && server.incoming.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {m.admin_networking_topology_isolated()}
              </p>
            ) : null}

            {server.outgoing.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {server.outgoing.map((link) => (
                  <li key={link.id}>
                    <button
                      type="button"
                      onClick={() => onSelection({ kind: "link", id: link.id })}
                      aria-pressed={isSelected(selection, "link", link.id)}
                      className={cn(
                        "flex w-full flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 text-start text-xs outline-none",
                        "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/24",
                        isSelected(selection, "link", link.id) && "bg-accent",
                      )}
                    >
                      <ArrowUpRightIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 break-words">
                        {m.admin_networking_topology_link_to({
                          server: link.peerServerName,
                          inbound: link.inboundName,
                        })}
                      </span>
                      <Badge variant={linkPhaseTone(link.phase)}>
                        {PHASE_LABEL[link.phase]()}
                      </Badge>
                      <Badge variant={linkHealthTone(link.health)}>
                        {HEALTH_LABEL[link.health]()}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {server.incoming.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {server.incoming.map((link) => (
                  <li
                    key={link.id}
                    className="flex flex-wrap items-center gap-1.5 px-2 text-xs text-muted-foreground"
                  >
                    <ArrowDownLeftIcon aria-hidden className="size-3.5" />
                    <span className="min-w-0 flex-1 break-words">
                      {m.admin_networking_topology_link_from({
                        server: link.peerServerName,
                        inbound: link.inboundName,
                      })}
                    </span>
                    <Badge variant={linkPhaseTone(link.phase)}>
                      {PHASE_LABEL[link.phase]()}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        </li>
      ))}
    </ul>
  );
}
