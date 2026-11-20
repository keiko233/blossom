"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import { nextLogIndex, type LogViewEntry } from "@/lib/admin-logs-view";
import { m } from "@/paraglide/messages";

import { LogLineText } from "./log-line-text";

export interface LogViewerProps {
  entries: LogViewEntry[];
  following: boolean;
  selected: ReadonlySet<string>;
  onToggleSelected(entryId: string): void;
  onPause(): void;
  onResume(): void;
  onOpenContext(entry: Extract<LogViewEntry, { kind: "record" }>): void;
}

const ROW_HEIGHT = 26;

function gapLabel(entry: Extract<LogViewEntry, { kind: "gap" }>): string {
  switch (entry.reason) {
    case "restarted":
      return m.agent_logs_gap_restarted();
    case "overwritten":
      return m.agent_logs_gap_overwritten({
        from: entry.fromSeq,
        to: entry.toSeq,
      });
    case "dropped":
      return m.agent_logs_gap_dropped();
  }
}

/**
 * Bounded, virtualized tail view. Only the visible rows and a small overscan
 * mount; selection and keyboard navigation never depend on a row being in the
 * DOM because the active index drives scrolling.
 */
export function LogViewer({
  entries,
  following,
  selected,
  onToggleSelected,
  onPause,
  onResume,
  onOpenContext,
}: LogViewerProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousScrollTop = useRef(0);
  const [activeIndex, setActiveIndex] = useState(
    entries.length > 0 ? entries.length - 1 : 0,
  );

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    if (!following || entries.length === 0) {
      return;
    }
    setActiveIndex(entries.length - 1);
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [entries.length, following, virtualizer]);

  const activeEntry = entries[activeIndex];
  const activeId = activeEntry ? `log-row-${activeEntry.id}` : undefined;

  const toggleEntry = (entry: LogViewEntry | undefined) => {
    if (entry?.kind === "record") {
      onToggleSelected(entry.id);
    }
  };

  const openEntry = (entry: LogViewEntry | undefined) => {
    if (entry?.kind === "record") {
      onOpenContext(entry);
    }
  };

  return (
    <>
      <p id="agent-logs-keyboard-hint" className="sr-only">
        {m.agent_logs_keyboard_hint()}
      </p>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label={m.agent_logs_view_label()}
        aria-describedby="agent-logs-keyboard-hint"
        aria-multiselectable="true"
        aria-activedescendant={activeId}
        tabIndex={0}
        data-slot="agent-log-viewer"
        className="h-[28rem] overflow-auto rounded-lg border bg-background/60 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            32;
          if (
            following &&
            !nearBottom &&
            element.scrollTop < previousScrollTop.current - 4
          ) {
            onPause();
          }
          previousScrollTop.current = element.scrollTop;
        }}
        onKeyDown={(event) => {
          const next = nextLogIndex(event.key, activeIndex, entries.length, 10);
          if (next !== null) {
            event.preventDefault();
            setActiveIndex(next);
            virtualizer.scrollToIndex(next, { align: "auto" });
            return;
          }
          if (event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            toggleEntry(entries[activeIndex]);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            openEntry(entries[activeIndex]);
            return;
          }
          if (event.key.toLowerCase() === "f") {
            event.preventDefault();
            if (following) {
              onPause();
            } else {
              onResume();
            }
          }
        }}
      >
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const entry = entries[virtualItem.index]!;
            const isActive = virtualItem.index === activeIndex;
            const isSelected =
              entry.kind === "record" && selected.has(entry.id);
            const rowClass = isActive
              ? "bg-accent/60"
              : entry.kind === "gap"
                ? "bg-warning/8 text-warning-foreground"
                : "hover:bg-accent/40";

            return (
              <div
                key={entry.id}
                id={`log-row-${entry.id}`}
                role="option"
                aria-selected={entry.kind === "record" ? isSelected : false}
                aria-disabled={entry.kind === "gap" || undefined}
                data-slot={entry.kind === "record" ? "log-row" : "log-gap"}
                className={`absolute start-0 top-0 flex h-[26px] w-max min-w-full items-center gap-2 px-2 whitespace-pre ${rowClass}`}
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                onClick={() => {
                  setActiveIndex(virtualItem.index);
                  toggleEntry(entry);
                }}
                onDoubleClick={() => openEntry(entry)}
              >
                {entry.kind === "record" ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-input bg-background"
                    >
                      {isSelected ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {entry.record.time.slice(11, 23)}
                    </span>
                    <span className="shrink-0 font-semibold">
                      {entry.record.level}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {entry.record.source}
                    </span>
                    <LogLineText text={entry.record.text} />
                    {entry.record.truncated ? (
                      <span className="shrink-0 text-warning-foreground">
                        {m.agent_logs_truncated()}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="font-sans">{gapLabel(entry)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
