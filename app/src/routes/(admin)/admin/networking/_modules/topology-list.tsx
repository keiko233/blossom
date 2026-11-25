import type React from "react";
import { Fragment, useId, useRef } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  isSameSelection,
  moveTopologySelection,
  topologySelectionOrder,
  type TopologyList as TopologyListModel,
  type TopologyMove,
  type TopologySelection,
} from "@/lib/networking-topology";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

import { HEALTH_LABEL, PHASE_LABEL } from "./topology-labels";

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

function itemKey(selection: TopologySelection): string {
  return `${selection.kind}:${selection.id}`;
}

function parseItem(element: Element | null): TopologySelection | null {
  const item = element?.closest<HTMLElement>("[data-topology-kind]");
  const kind = item?.dataset.topologyKind;
  const id = item?.dataset.topologyId;
  if (!id || (kind !== "server" && kind !== "link")) return null;
  return { kind, id };
}

function summarize<T extends string>(
  values: readonly T[],
  label: Record<T, () => string>,
): string {
  const distinct = [...new Set(values)];
  if (distinct.length === 0) return "—";
  return distinct.map((value) => label[value]()).join(" · ");
}

/**
 * Dense, keyboard-accessible table equivalent of the graph. One roving tab
 * stop: arrows, Home and End move the shared selection between servers and
 * their outgoing links. Selecting a link here lights the same edge in the
 * graph and fills the inspector.
 */
export function TopologyList({
  list,
  filtered,
  selection,
  onSelectionChange,
  className,
}: TopologyListProps): React.ReactElement {
  const hintId = useId();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const order = topologySelectionOrder(list.servers);
  const tabStop = selection ?? order[0] ?? null;

  const select = (next: TopologySelection) => {
    const escape =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(itemKey(next))
        : itemKey(next);
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-topology-item="${escape}"]`)
      ?.focus();
    onSelectionChange(next);
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLTableSectionElement>,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      const focused = parseItem(document.activeElement);
      if (!focused) return;
      event.preventDefault();
      onSelectionChange(focused);
      return;
    }

    const move = MOVE_KEYS[event.key];
    if (!move) return;
    const next = moveTopologySelection(list.servers, selection, move);
    if (!next) return;
    event.preventDefault();
    select(next);
  };

  const itemProps = (item: TopologySelection) => ({
    "data-topology-item": itemKey(item),
    "data-topology-kind": item.kind,
    "data-topology-id": item.id,
    "data-state": isSameSelection(item, selection) ? "selected" : undefined,
    "aria-current": isSameSelection(item, selection)
      ? ("true" as const)
      : undefined,
    tabIndex: isSameSelection(item, tabStop) ? 0 : -1,
    onClick: () => onSelectionChange(item),
    className: cn(
      "cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
      !isSameSelection(item, selection) && "text-muted-foreground",
    ),
  });

  if (list.servers.length === 0) {
    return (
      <p className={cn("p-4 text-sm text-muted-foreground", className)}>
        {filtered
          ? m.admin_networking_topology_no_match()
          : m.admin_networking_topology_empty()}
      </p>
    );
  }

  return (
    <div
      data-slot="topology-list"
      // The pane table pins its header against `--page-header-h` and
      // `--page-toolbar-h`; a workbench canvas has neither, so zero them here
      // and the header sticks to the top of its own scroller.
      className={cn(
        "h-full min-h-0 overflow-y-auto [--page-header-h:0rem] [--page-toolbar-h:0rem]",
        className,
      )}
    >
      <p id={hintId} className="sr-only">
        {m.admin_networking_topology_list_hint()}
      </p>
      {list.unresolvedLinkIds.length > 0 ? (
        <p
          role="status"
          className="border-b px-4 py-2 text-xs text-warning-foreground"
        >
          {m.admin_networking_topology_unresolved({
            count: list.unresolvedLinkIds.length,
          })}
        </p>
      ) : null}

      <Table
        variant="pane"
        aria-label={m.admin_networking_topology_list_label()}
      >
        <TableHeader className="[&_tr]:border-b [&_tr]:bg-background">
          <TableRow>
            <TableHead>
              {m.admin_networking_topology_wb_column_server()}
            </TableHead>
            <TableHead>
              {m.admin_networking_topology_wb_column_state()}
            </TableHead>
            <TableHead className="text-end">
              {m.admin_networking_topology_wb_column_outgoing()}
            </TableHead>
            <TableHead className="text-end">
              {m.admin_networking_topology_wb_column_incoming()}
            </TableHead>
            <TableHead>
              {m.admin_networking_topology_wb_column_phase()}
            </TableHead>
            <TableHead>
              {m.admin_networking_topology_wb_column_health()}
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody
          ref={bodyRef}
          aria-describedby={hintId}
          onKeyDown={handleKeyDown}
        >
          {list.servers.map((server) => (
            <Fragment key={server.id}>
              <TableRow {...itemProps({ kind: "server", id: server.id })}>
                <TableCell className="max-w-64 truncate font-medium">
                  {server.name}
                </TableCell>
                <TableCell>
                  {server.enabled
                    ? m.admin_networking_topology_enabled()
                    : m.admin_networking_topology_server_disabled()}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {server.outgoing.length}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {server.incoming.length}
                </TableCell>
                <TableCell>
                  {summarize(
                    [...server.outgoing, ...server.incoming].map(
                      (link) => link.phase,
                    ),
                    PHASE_LABEL,
                  )}
                </TableCell>
                <TableCell>
                  {summarize(
                    [...server.outgoing, ...server.incoming].map(
                      (link) => link.health,
                    ),
                    HEALTH_LABEL,
                  )}
                </TableCell>
              </TableRow>

              {server.outgoing.map((link) => (
                <TableRow
                  key={link.id}
                  {...itemProps({ kind: "link", id: link.id })}
                >
                  <TableCell className="ps-6">
                    <span aria-hidden className="me-1.5">
                      →
                    </span>
                    <span className="font-mono text-xs">
                      {link.peerServerName}
                    </span>
                    <span className="ms-1.5 text-xs">· {link.inboundName}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {link.protocol}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">—</TableCell>
                  <TableCell className="text-end tabular-nums">—</TableCell>
                  <TableCell>{PHASE_LABEL[link.phase]()}</TableCell>
                  <TableCell>{HEALTH_LABEL[link.health]()}</TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
