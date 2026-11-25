"use client";

import type { AgentWsV2LogRecord } from "@blossom/contracts/agent-ws-v2-logs";
import { useVirtualizer } from "@tanstack/react-virtual";
import { InfoIcon, XIcon } from "lucide-react";
import type React from "react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { LogSearchState } from "@/lib/admin-logs-view";
import {
  formatLogTime,
  logLevelVariant,
  logLevelVariants,
  padLevel,
} from "@/lib/log-view-format";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

import { logErrorMessage } from "./log-error-message";
import { LogLineText } from "./log-line-text";

const ROW_HEIGHT = 26;

export interface LogSearchResultsProps {
  search: LogSearchState;
  query: string;
  placement: "right" | "bottom";
  onOpen(record: AgentWsV2LogRecord, generation: string): void;
  onLoadMore(): void;
  onClose(): void;
}

function coverageText(search: LogSearchState): string {
  const from = search.coverage?.searchableFrom ?? null;
  const to = search.coverage?.searchableTo ?? null;
  return from && to
    ? m.agent_logs_search_coverage({ from, to })
    : m.agent_logs_search_coverage_unknown();
}

export function LogSearchResults({
  search,
  query,
  placement,
  onOpen,
  onLoadMore,
  onClose,
}: LogSearchResultsProps): React.ReactElement {
  const generation = search.generation;
  const showSkeleton =
    search.status === "searching" && search.results.length === 0;
  const showEmpty = search.status === "complete" && search.results.length === 0;

  return (
    <section
      aria-label={m.agent_logs_results_title()}
      data-slot="log-search-results"
      className={cn(
        "flex min-h-0 flex-col bg-background",
        placement === "right"
          ? "w-112 shrink-0 border-s"
          : "h-[min(40%,18rem)] shrink-0 border-t",
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="shrink-0 font-medium">
          {m.agent_logs_results_title()}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {m.agent_logs_search_results_count({ count: search.results.length })}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex cursor-default text-muted-foreground" />
            }
          >
            <InfoIcon className="size-3.5" aria-label={coverageText(search)} />
          </TooltipTrigger>
          <TooltipPopup className="max-w-sm">
            <span className="flex flex-col gap-1">
              <span>{coverageText(search)}</span>
              <span className="text-muted-foreground">
                {m.agent_logs_results_coverage_hint()}
              </span>
            </span>
          </TooltipPopup>
        </Tooltip>
        {search.next ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0"
            loading={search.searchingMore}
            onClick={onLoadMore}
          >
            {m.agent_logs_action_load_more()}
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="ms-auto shrink-0"
                aria-label={m.agent_logs_results_close()}
                onClick={onClose}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>{m.agent_logs_results_close()}</TooltipPopup>
        </Tooltip>
      </div>

      {search.status === "error" ? (
        <p role="alert" className="p-3 text-sm text-destructive-foreground">
          {logErrorMessage(search.error)}
        </p>
      ) : showSkeleton ? (
        <div role="status" aria-busy="true" className="flex flex-col">
          <span className="sr-only">{m.admin_ui_loading()}</span>
          {Array.from({ length: 6 }, (_, row) => (
            <div
              key={row}
              className="flex h-[26px] items-center gap-2 border-b px-2"
            >
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-2.5 w-10" />
              <Skeleton className="h-2.5 flex-1" />
            </div>
          ))}
        </div>
      ) : showEmpty ? (
        <Empty className="gap-2 p-6 md:p-8">
          <EmptyTitle className="text-sm font-medium">
            {m.agent_logs_search_empty()}
          </EmptyTitle>
          <EmptyDescription className="text-xs">
            {m.agent_logs_search_coverage_unknown()}
          </EmptyDescription>
        </Empty>
      ) : (
        <SearchResultList
          results={search.results}
          query={query}
          generation={generation}
          onOpen={onOpen}
        />
      )}

      {search.incomplete ? (
        <p
          role="status"
          className="shrink-0 border-t bg-warning/8 px-3 py-1.5 text-xs text-warning-foreground"
        >
          {m.agent_logs_search_incomplete()}
        </p>
      ) : null}
    </section>
  );
}

function SearchResultList({
  results,
  query,
  generation,
  onOpen,
}: {
  results: AgentWsV2LogRecord[];
  query: string;
  generation: string | null;
  onOpen(record: AgentWsV2LogRecord, generation: string): void;
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div
      ref={scrollRef}
      role="list"
      className="min-h-0 flex-1 overflow-auto font-mono text-xs"
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const record = results[virtualItem.index]!;
          return (
            <div
              key={record.seq}
              className="absolute start-0 top-0 w-full"
              style={{ height: `${ROW_HEIGHT}px` }}
            >
              <button
                type="button"
                className="flex h-[26px] w-full items-center gap-2 px-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:ring-inset disabled:opacity-64"
                aria-label={m.agent_logs_context_open_at({ time: record.time })}
                title={m.agent_logs_results_open_hint()}
                disabled={!generation}
                onClick={() => {
                  if (generation) {
                    onOpen(record, generation);
                  }
                }}
              >
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatLogTime(record.time)}
                </span>
                <span
                  className={logLevelVariants({
                    level: logLevelVariant(record.level),
                  })}
                >
                  {padLevel(record.level)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {record.source}
                </span>
                <span className="min-w-0 flex-1 truncate whitespace-pre">
                  <LogLineText text={record.text} query={query} />
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
