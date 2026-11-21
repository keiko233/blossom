import { Accessibility } from "@dnd-kit/dom";
import { move } from "@dnd-kit/helpers";
import {
  DragDropProvider,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useDroppable,
} from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import {
  EntrancePublicationBadge,
  entranceReadinessLabel,
  NodeHealthBadge,
} from "@/components/node-health-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deriveEntranceStatus,
  type EntranceReadiness,
  listEntranceProtocols,
  membershipDisplayColumns,
} from "@/lib/group-entrance-filter";
import {
  addEntrance,
  type MembershipColumn,
  type MembershipColumns,
  removeEntrance,
  shiftEntrance,
} from "@/lib/group-membership-draft";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { NodeListItem } from "@/query/nodes";

/** `CollisionPriority.Low` (`@dnd-kit/abstract`): rows win over columns. */
const COLUMN_COLLISION_PRIORITY = 1;
const ENTRANCE_TYPE = "entrance";
const ALL_FILTER = "all";

export interface GroupMembershipEditorProps {
  nodes: readonly NodeListItem[];
  /** Draft membership in subscription order. */
  value: readonly string[];
  onChange: (nodeIds: string[]) => void;
}

interface ColumnDisplay extends MembershipColumns<NodeListItem> {
  columnIds: { available: string[]; selected: string[] };
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id)) && rightSet.size === left.length;
}

function columnOf(
  entity: { id?: unknown; group?: unknown } | null | undefined,
): MembershipColumn | undefined {
  const id = typeof entity?.group === "string" ? entity.group : entity?.id;
  return id === "available" || id === "selected" ? id : undefined;
}

/**
 * Two-column ordered membership editor. The draft lives with the caller
 * (TanStack Form `nodeIds`); this component only proposes new drafts.
 *
 * Drag follows the dnd kit multiple-list pattern: `onDragOver` applies `move`
 * to exactly the displayed columns so React owns every DOM move, and a canceled
 * drag restores the pre-drag draft. The available column is derived and
 * unordered, so sorting inside it is blocked and a drop there is a removal.
 * The node list is frozen for the duration of a drag so a background refetch
 * cannot shift targets under the pointer or keyboard.
 */
export function GroupMembershipEditor({
  nodes,
  value,
  onChange,
}: GroupMembershipEditorProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [protocol, setProtocol] = React.useState<string | undefined>(undefined);
  const [readiness, setReadiness] = React.useState<
    EntranceReadiness | undefined
  >(undefined);
  const [dragNodes, setDragNodes] = React.useState<
    readonly NodeListItem[] | null
  >(null);
  const [announcement, setAnnouncement] = React.useState({
    id: 0,
    text: "",
  });

  const draftRef = React.useRef(value);
  draftRef.current = value;
  const preDragDraft = React.useRef<readonly string[]>(value);
  const nodesRef = React.useRef<readonly NodeListItem[]>(nodes);
  nodesRef.current = dragNodes ?? nodes;

  const activeNodes = dragNodes ?? nodes;
  const now = Date.now();
  const display: ColumnDisplay = membershipDisplayColumns(
    activeNodes,
    value,
    { query, protocol, readiness },
    now,
  );
  const displayRef = React.useRef(display);
  displayRef.current = display;

  const nodeName = React.useCallback((id: string): string => {
    const node = nodesRef.current.find((entry) => entry.id === id);
    return node?.name ?? id;
  }, []);

  const announce = React.useCallback((text: string) => {
    setAnnouncement((current) => ({ id: current.id + 1, text }));
  }, []);

  const add = (node: NodeListItem) => {
    onChange(addEntrance(draftRef.current, node.id));
    announce(m.admin_proxies_groups_members_sr_added({ name: node.name }));
  };

  const remove = (id: string) => {
    onChange(removeEntrance(draftRef.current, id));
    announce(m.admin_proxies_groups_members_sr_removed({ name: nodeName(id) }));
  };

  const shift = (id: string, delta: -1 | 1) => {
    const next = shiftEntrance(draftRef.current, id, delta);
    const position = next.indexOf(id) + 1;
    if (position > 0) {
      onChange(next);
      announce(
        m.admin_proxies_groups_members_sr_moved({
          name: nodeName(id),
          position,
        }),
      );
    }
  };

  const applyDragMove = (event: DragOverEvent, columns: ColumnDisplay) => {
    const { source, target } = event.operation;
    if (!source || !target) return;

    const sourceColumn = isSortable(source) ? source.initialGroup : undefined;
    const targetColumn = isSortable(target) ? target.group : columnOf(target);
    if (sourceColumn === "available" && targetColumn === "available") {
      event.preventDefault();
      return;
    }

    const sourceId = String(source.id);
    const current = draftRef.current;
    const expected =
      targetColumn === "available"
        ? current.filter((id) => id !== sourceId)
        : current.includes(sourceId)
          ? current
          : [...current, sourceId];

    const next = move(columns.columnIds, event).selected;
    if (!sameIdSet(next, expected)) {
      // A move that would drop, duplicate or invent IDs is refused rather
      // than silently changing the draft.
      event.preventDefault();
      return;
    }
    if (!sameIdSet(next, current) || next.some((id, i) => id !== current[i])) {
      onChange(next);
    }
  };

  const moveAnnouncement = (event: DragEndEvent): string | undefined => {
    if (event.canceled) {
      const source = event.operation.source;
      return source
        ? m.admin_proxies_groups_members_sr_cancel({
            name: nodeName(String(source.id)),
          })
        : undefined;
    }
    const { source, target } = event.operation;
    if (!source) return undefined;
    const name = nodeName(String(source.id));
    const sourceColumn = isSortable(source) ? source.initialGroup : undefined;
    const targetColumn = isSortable(target)
      ? target.group
      : target
        ? columnOf(target)
        : undefined;
    if (targetColumn === "available" && sourceColumn === "selected") {
      return m.admin_proxies_groups_members_sr_dropped_removed({ name });
    }
    if (targetColumn === "selected" && sourceColumn === "available") {
      return m.admin_proxies_groups_members_sr_dropped_added({ name });
    }
    if (targetColumn === "selected") {
      const position = draftRef.current.indexOf(String(source.id)) + 1;
      return position > 0
        ? m.admin_proxies_groups_members_sr_dropped_position({
            name,
            position,
          })
        : m.admin_proxies_groups_members_sr_dropped({ name });
    }
    return m.admin_proxies_groups_members_sr_dropped({ name });
  };

  const protocolOptions = listEntranceProtocols(activeNodes);
  const selectedIds = new Set(value);
  const unselectedTotal = activeNodes.reduce(
    (total, node) => total + (selectedIds.has(node.id) ? 0 : 1),
    0,
  );
  const filtersActive =
    query.trim().length > 0 || Boolean(protocol) || Boolean(readiness);

  return (
    <DragDropProvider
      plugins={(defaults) =>
        defaults.map((plugin) =>
          plugin === Accessibility
            ? Accessibility.configure({
                announcements: {
                  dragstart: (event: DragStartEvent) =>
                    m.admin_proxies_groups_members_sr_pick_up({
                      name: nodeName(String(event.operation.source?.id ?? "")),
                    }),
                  dragover: (event: DragOverEvent) => {
                    const name = nodeName(
                      String(event.operation.source?.id ?? ""),
                    );
                    const targetColumn = isSortable(event.operation.target)
                      ? event.operation.target.group
                      : columnOf(event.operation.target);
                    return targetColumn === "selected"
                      ? m.admin_proxies_groups_members_sr_over_selected({
                          name,
                        })
                      : m.admin_proxies_groups_members_sr_over_available({
                          name,
                        });
                  },
                  dragend: (event: DragEndEvent) => moveAnnouncement(event),
                },
                screenReaderInstructions: {
                  draggable: m.admin_proxies_groups_members_sr_instructions(),
                },
              })
            : plugin,
        )
      }
      onDragStart={() => {
        preDragDraft.current = draftRef.current;
        setDragNodes(nodesRef.current);
      }}
      onDragOver={(event) => applyDragMove(event, displayRef.current)}
      onDragEnd={(event) => {
        if (event.canceled) {
          onChange([...preDragDraft.current]);
        }
        setDragNodes(null);
      }}
    >
      <div className="flex flex-col gap-3">
        <div
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-slot="group-membership-announcement"
          role="status"
        >
          <span key={announcement.id}>{announcement.text}</span>
        </div>
        <p className="sr-only">
          {m.admin_proxies_groups_members_sr_instructions()}
        </p>

        <div
          data-slot="group-membership-editor"
          className="grid min-w-0 gap-4 md:min-h-0 md:grid-cols-2"
        >
          <MembershipColumnList
            column="available"
            title={m.admin_proxies_groups_members_available()}
            count={m.admin_proxies_groups_members_visible_count({
              visible: display.available.length,
              total: unselectedTotal,
            })}
            emptyMessage={
              filtersActive
                ? m.admin_proxies_groups_members_no_matches()
                : m.admin_proxies_groups_members_no_available()
            }
            toolbar={
              <div className="flex flex-col gap-2">
                <Input
                  aria-label={m.admin_proxies_groups_members_search_label()}
                  placeholder={m.admin_proxies_groups_field_nodes_placeholder()}
                  type="search"
                  value={query}
                  onValueChange={setQuery}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    items={[
                      {
                        label:
                          m.admin_proxies_groups_members_filter_all_protocols(),
                        value: ALL_FILTER,
                      },
                      ...protocolOptions.map((value) => ({
                        label: value,
                        value,
                      })),
                    ]}
                    value={protocol ?? ALL_FILTER}
                    onValueChange={(next) =>
                      setProtocol(
                        next === ALL_FILTER ? undefined : (next ?? undefined),
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={m.admin_proxies_groups_members_filter_protocol()}
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={ALL_FILTER}>
                        {m.admin_proxies_groups_members_filter_all_protocols()}
                      </SelectItem>
                      {protocolOptions.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select
                    items={{
                      [ALL_FILTER]:
                        m.admin_proxies_groups_members_filter_all_readiness(),
                      ready: m.admin_proxies_groups_members_readiness_ready(),
                      pending:
                        m.admin_proxies_groups_members_readiness_pending(),
                      withheld:
                        m.admin_proxies_groups_members_readiness_withheld(),
                    }}
                    value={readiness ?? ALL_FILTER}
                    onValueChange={(next) =>
                      setReadiness(
                        next === ALL_FILTER
                          ? undefined
                          : (next as EntranceReadiness | undefined),
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={m.admin_proxies_groups_members_filter_readiness()}
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={ALL_FILTER}>
                        {m.admin_proxies_groups_members_filter_all_readiness()}
                      </SelectItem>
                      <SelectItem value="ready">
                        {m.admin_proxies_groups_members_readiness_ready()}
                      </SelectItem>
                      <SelectItem value="pending">
                        {m.admin_proxies_groups_members_readiness_pending()}
                      </SelectItem>
                      <SelectItem value="withheld">
                        {m.admin_proxies_groups_members_readiness_withheld()}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            }
          >
            {display.available.map((node, index) => (
              <EntranceRow
                key={node.id}
                id={node.id}
                column="available"
                index={index}
                node={node}
              >
                <EntranceBadges node={node} selected={false} />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.admin_proxies_groups_members_add({
                    name: node.name,
                  })}
                  onClick={() => add(node)}
                >
                  <PlusIcon />
                </Button>
              </EntranceRow>
            ))}
          </MembershipColumnList>

          <MembershipColumnList
            column="selected"
            title={m.admin_proxies_groups_members_selected()}
            count={m.admin_proxies_groups_members_selected_count({
              count: display.selected.length,
            })}
            emptyMessage={m.admin_proxies_groups_members_drop_empty()}
          >
            {display.selected.map((entry, index) => (
              <EntranceRow
                key={entry.id}
                id={entry.id}
                column="selected"
                index={index}
                node={entry.node}
                missing={entry.node === null}
              >
                {entry.node ? (
                  <EntranceBadges node={entry.node} selected />
                ) : (
                  <Badge variant="warning">
                    {m.admin_proxies_groups_members_missing()}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.admin_proxies_groups_members_move_up({
                    name: entry.node?.name ?? entry.id,
                  })}
                  disabled={index === 0}
                  onClick={() => shift(entry.id, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.admin_proxies_groups_members_move_down({
                    name: entry.node?.name ?? entry.id,
                  })}
                  disabled={index === display.selected.length - 1}
                  onClick={() => shift(entry.id, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.admin_proxies_groups_members_remove({
                    name: entry.node?.name ?? entry.id,
                  })}
                  onClick={() => remove(entry.id)}
                >
                  <XIcon />
                </Button>
              </EntranceRow>
            ))}
          </MembershipColumnList>
        </div>

        {display.missingIds.length > 0 ? (
          <p className="text-xs text-destructive" role="status">
            {m.admin_proxies_groups_members_missing_hint({
              count: display.missingIds.length,
            })}
          </p>
        ) : null}
        {filtersActive ? (
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_groups_members_filter_note()}
          </p>
        ) : null}
      </div>
    </DragDropProvider>
  );
}

interface MembershipColumnListProps {
  column: MembershipColumn;
  title: string;
  count: string;
  /** Shown inside the drop target when the column has no rows. */
  emptyMessage?: string;
  toolbar?: React.ReactNode;
  children: React.ReactNode[];
}

function MembershipColumnList({
  column,
  title,
  count,
  emptyMessage,
  toolbar,
  children,
}: MembershipColumnListProps): React.ReactElement {
  const { ref, isDropTarget } = useDroppable({
    id: column,
    type: "column",
    accept: ENTRANCE_TYPE,
    collisionPriority: COLUMN_COLLISION_PRIORITY,
  });

  return (
    <section
      data-slot="group-membership-column"
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      {toolbar}
      <ul
        ref={ref}
        className={cn(
          "flex min-h-24 flex-col gap-1 overflow-y-auto p-1",
          "max-h-[45dvh] rounded-lg border bg-card",
          "md:max-h-[min(58dvh,42rem)]",
          isDropTarget && "ring-2 ring-ring",
        )}
      >
        {children.length === 0 && emptyMessage ? (
          <li className="m-auto p-4 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </li>
        ) : (
          children
        )}
      </ul>
    </section>
  );
}

interface EntranceRowProps {
  id: string;
  column: MembershipColumn;
  index: number;
  node: NodeListItem | null;
  missing?: boolean;
  /** Explicit, drag-free actions for this row. */
  children: React.ReactNode;
}

function EntranceRow({
  id,
  column,
  index,
  node,
  missing = false,
  children,
}: EntranceRowProps): React.ReactElement {
  const { ref, handleRef, isDragging } = useSortable({
    id,
    index,
    group: column,
    type: ENTRANCE_TYPE,
    accept: ENTRANCE_TYPE,
  });

  return (
    <li
      ref={ref}
      data-slot="group-membership-entrance"
      className={cn(
        "flex items-center gap-2 rounded-md px-1 py-1.5",
        "bg-card text-sm",
        missing && "border border-destructive/32 bg-destructive/4",
        isDragging && "opacity-60",
      )}
    >
      <button
        ref={handleRef}
        type="button"
        aria-label={m.admin_proxies_groups_members_drag({
          name: node?.name ?? id,
        })}
        className="cursor-grab rounded-sm p-1 text-muted-foreground"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {node?.name ?? m.admin_proxies_groups_members_missing_name()}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {node
            ? `${node.serverSummary.name} · ${node.resolvedAddress}:${node.listenPort} · ${node.protocol}`
            : m.admin_proxies_groups_members_missing_id()}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {children}
      </div>
    </li>
  );
}

function EntranceBadges({
  node,
  selected,
}: {
  node: NodeListItem;
  selected: boolean;
}): React.ReactElement {
  const status = deriveEntranceStatus(node);
  return (
    <>
      <Badge variant="outline">{node.protocol}</Badge>
      {selected ? (
        <EntrancePublicationBadge publication={status.publication} />
      ) : (
        <Badge variant="outline">
          {entranceReadinessLabel(status.readiness)}
        </Badge>
      )}
      <NodeHealthBadge health={status.health} />
    </>
  );
}
