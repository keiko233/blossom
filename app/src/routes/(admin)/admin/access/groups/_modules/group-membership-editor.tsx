import { move } from "@dnd-kit/helpers";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  addEntrance,
  type MembershipColumn,
  removeEntrance,
  shiftEntrance,
  splitMembershipColumns,
} from "@/lib/group-membership-draft";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { NodeListItem } from "@/query/nodes";

/** `CollisionPriority.Low` (`@dnd-kit/abstract`): rows win over columns. */
const COLUMN_COLLISION_PRIORITY = 1;
const ENTRANCE_TYPE = "entrance";

export interface GroupMembershipEditorProps {
  nodes: readonly NodeListItem[];
  /** Draft membership in subscription order. */
  value: readonly string[];
  onChange: (nodeIds: string[]) => void;
}

/**
 * Two-column ordered membership editor. The draft lives with the caller
 * (TanStack Form `nodeIds`); this component only proposes new drafts.
 *
 * Drag follows the dnd kit multiple-list pattern: `onDragOver` applies `move`
 * to the rendered columns so React owns every DOM move, and a canceled drag
 * restores the pre-drag draft. The available column is derived and unordered,
 * so sorting inside it is blocked and a drop there is a removal.
 */
export function GroupMembershipEditor({
  nodes,
  value,
  onChange,
}: GroupMembershipEditorProps): React.ReactElement {
  const preDragDraft = React.useRef<readonly string[]>(value);

  const columns = splitMembershipColumns(nodes, value);
  const columnIds: Record<MembershipColumn, string[]> = {
    available: columns.available.map((node) => node.id),
    selected: columns.selected.map((node) => node.id),
  };

  return (
    <DragDropProvider
      onDragStart={() => {
        preDragDraft.current = value;
      }}
      onDragOver={(event) => {
        const { source, target } = event.operation;
        const sourceColumn = isSortable(source) ? source.group : undefined;
        const targetColumn = isSortable(target) ? target.group : target?.id;
        if (sourceColumn === "available" && targetColumn === "available") {
          event.preventDefault();
          return;
        }
        onChange(move(columnIds, event).selected);
      }}
      onDragEnd={(event) => {
        if (event.canceled) onChange([...preDragDraft.current]);
      }}
    >
      <div
        data-slot="group-membership-editor"
        className="grid gap-4 md:grid-cols-2"
      >
        <MembershipColumnList
          column="available"
          title={m.admin_proxies_groups_members_available()}
        >
          {columns.available.map((node, index) => (
            <EntranceRow
              key={node.id}
              column="available"
              index={index}
              node={node}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.admin_proxies_groups_members_add({
                  name: node.name,
                })}
                onClick={() => onChange(addEntrance(value, node.id))}
              >
                <PlusIcon />
              </Button>
            </EntranceRow>
          ))}
        </MembershipColumnList>

        <MembershipColumnList
          column="selected"
          title={m.admin_proxies_groups_members_selected()}
          emptyMessage={m.admin_proxies_groups_members_drop_empty()}
        >
          {columns.selected.map((node, index) => (
            <EntranceRow
              key={node.id}
              column="selected"
              index={index}
              node={node}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.admin_proxies_groups_members_move_up({
                  name: node.name,
                })}
                disabled={index === 0}
                onClick={() => onChange(shiftEntrance(value, node.id, -1))}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.admin_proxies_groups_members_move_down({
                  name: node.name,
                })}
                disabled={index === columns.selected.length - 1}
                onClick={() => onChange(shiftEntrance(value, node.id, 1))}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.admin_proxies_groups_members_remove({
                  name: node.name,
                })}
                onClick={() => onChange(removeEntrance(value, node.id))}
              >
                <XIcon />
              </Button>
            </EntranceRow>
          ))}
        </MembershipColumnList>
      </div>
    </DragDropProvider>
  );
}

interface MembershipColumnListProps {
  column: MembershipColumn;
  title: string;
  /** Shown inside the drop target when the column has no rows. */
  emptyMessage?: string;
  children: React.ReactNode[];
}

function MembershipColumnList({
  column,
  title,
  emptyMessage,
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
      className="flex min-w-0 flex-col gap-2"
    >
      <h3 className="text-sm font-medium">{title}</h3>
      <ul
        ref={ref}
        className={cn(
          "flex max-h-112 min-h-24 flex-col gap-1 overflow-y-auto",
          "rounded-lg border bg-card p-1",
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
  column: MembershipColumn;
  index: number;
  node: NodeListItem;
  /** Explicit, drag-free actions for this row. */
  children: React.ReactNode;
}

function EntranceRow({
  column,
  index,
  node,
  children,
}: EntranceRowProps): React.ReactElement {
  const { ref, handleRef, isDragging } = useSortable({
    id: node.id,
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
        isDragging && "opacity-60",
      )}
    >
      <button
        ref={handleRef}
        type="button"
        aria-label={m.admin_proxies_groups_members_drag({ name: node.name })}
        className="cursor-grab rounded-sm p-1 text-muted-foreground"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{node.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {node.serverSummary.name} · {node.resolvedAddress}:{node.listenPort}
        </span>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </li>
  );
}
