"use client";

import type {
  AgentWsV2LogLevel,
  AgentWsV2LogRecord,
  AgentWsV2LogSource,
} from "@blossom/contracts/agent-ws-v2-logs";
import { CopyIcon, PauseIcon, PlayIcon, SearchIcon, XIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import {
  formatLogLine,
  isLogRecordEntry,
  logAvailability,
  type LogViewEntry,
} from "@/lib/admin-logs-view";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { LogContextDialog } from "./log-context-dialog";
import { logErrorMessage } from "./log-error-message";
import { LogLineText } from "./log-line-text";
import { LogViewer } from "./log-viewer";
import { useServerList } from "./use-server-list";
import { useServerLogs, type LogConnectionPhase } from "./use-server-logs";

export interface ServerLogsPanelProps {
  server: ServerDTO;
}

const SOURCE_OPTIONS = ["all", "agent", "sing-box"] as const;
const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error"] as const;

/** The datetime-local fields are deliberately interpreted as UTC. */
function toUtcIso(value: string): string | null {
  if (!value) {
    return null;
  }
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? `${value}:00`
    : value;
  const date = new Date(`${withSeconds}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function phaseBadge(phase: LogConnectionPhase): React.ReactElement {
  switch (phase) {
    case "live":
      return <Badge variant="success">{m.agent_logs_status_live()}</Badge>;
    case "paused":
      return <Badge variant="warning">{m.agent_logs_status_paused()}</Badge>;
    case "connecting":
      return <Badge variant="info">{m.agent_logs_status_connecting()}</Badge>;
    case "reconnecting":
      return (
        <Badge variant="warning">{m.agent_logs_status_reconnecting()}</Badge>
      );
    case "unauthorized":
      return (
        <Badge variant="error">{m.agent_logs_status_unauthorized()}</Badge>
      );
    case "unavailable":
      return (
        <Badge variant="outline">{m.agent_logs_status_unavailable()}</Badge>
      );
    case "unsupported":
      return (
        <Badge variant="outline">{m.agent_logs_status_unsupported()}</Badge>
      );
    case "error":
      return <Badge variant="error">{m.agent_logs_status_error()}</Badge>;
    case "idle":
      return <Badge variant="outline">{m.agent_logs_status_idle()}</Badge>;
  }
}

function searchableRange(from: string | null, to: string | null): string {
  return from && to
    ? m.agent_logs_search_coverage({ from, to })
    : m.agent_logs_search_coverage_unknown();
}

function SearchResultRow({
  record,
  generation,
  query,
  onOpen,
}: {
  record: AgentWsV2LogRecord;
  generation: string | null;
  query: string;
  onOpen(): void;
}): React.ReactElement {
  return (
    <li className="min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-transparent bg-muted/20 px-2 py-1.5 text-left font-mono text-xs outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-64"
        aria-label={m.agent_logs_context_open_at({ time: record.time })}
        disabled={!generation}
        onClick={onOpen}
      >
        <span className="shrink-0 text-muted-foreground">
          {record.time.slice(11, 23)}
        </span>
        <span className="shrink-0 font-semibold">{record.level}</span>
        <span className="shrink-0 text-muted-foreground">{record.source}</span>
        <span className="min-w-0 break-all">
          <LogLineText text={record.text} query={query} />
        </span>
      </button>
    </li>
  );
}

/**
 * The Logs tab: a same-origin relay subscription, retained search, context
 * lookup, filters and selected-line copy. Query text and records live only in
 * component state; nothing is written to the URL or browser storage.
 */
export function ServerLogsPanel({
  server,
}: ServerLogsPanelProps): React.ReactElement {
  const { data: servers } = useServerList();
  const live = servers?.find((row) => row.id === server.id) ?? server;
  const availability = logAvailability(live);
  const available = availability.kind === "available";
  const controller = useServerLogs({
    serverId: server.id,
    available,
    tailSupported: available ? availability.tail : false,
    searchSupported: available ? availability.search : false,
  });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [rangeInvalid, setRangeInvalid] = useState(false);
  const [lastSearchText, setLastSearchText] = useState("");
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    setSelected(new Set());
  }, [server.id, controller.filter.source, controller.filter.minLevel]);

  const recordEntries = controller.tail.entries.filter(isLogRecordEntry);
  const selectedRecords = recordEntries.filter((entry) =>
    selected.has(entry.id),
  );
  const searchGeneration = controller.search.generation;

  const toggleSelected = (entryId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  const copySelected = async () => {
    if (selectedRecords.length === 0) {
      toastManager.add({
        type: "warning",
        title: m.agent_logs_toast_nothing_selected(),
      });
      return;
    }
    setCopying(true);
    try {
      const text = selectedRecords
        .map((entry) => formatLogLine(entry.record))
        .join("\n");
      await navigator.clipboard.writeText(text);
      toastManager.add({
        type: "success",
        title: m.agent_logs_toast_copied({ count: selectedRecords.length }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.agent_logs_toast_copy_error(),
      });
    } finally {
      setCopying(false);
    }
  };

  const updateSource = (value: string | null) => {
    if (value === null) {
      return;
    }
    controller.setFilter({
      ...controller.filter,
      source: value === "all" ? undefined : (value as AgentWsV2LogSource),
    });
  };

  const updateLevel = (value: string | null) => {
    if (value === null) {
      return;
    }
    controller.setFilter({
      ...controller.filter,
      minLevel: value === "all" ? undefined : (value as AgentWsV2LogLevel),
    });
  };

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sinceIso = toUtcIso(since);
    const untilIso = toUtcIso(until);
    if (
      (since && !sinceIso) ||
      (until && !untilIso) ||
      (sinceIso && untilIso && Date.parse(sinceIso) >= Date.parse(untilIso))
    ) {
      setRangeInvalid(true);
      return;
    }
    setRangeInvalid(false);
    setLastSearchText(searchText.trim());
    controller.searchLogs({
      text: searchText,
      since: sinceIso,
      until: untilIso,
    });
  };

  const clearSearch = () => {
    setSearchText("");
    setSince("");
    setUntil("");
    setRangeInvalid(false);
    setLastSearchText("");
    controller.cancelSearch();
  };

  const openEntry = (entry: Extract<LogViewEntry, { kind: "record" }>) => {
    controller.openContext(entry.record, entry.generation);
  };

  const searchEmpty =
    controller.search.status === "complete" &&
    controller.search.results.length === 0;
  const tailEmpty =
    availability.kind === "available" &&
    availability.tail &&
    controller.tail.entries.length === 0 &&
    controller.phase !== "connecting" &&
    controller.phase !== "reconnecting";

  return (
    <section
      data-slot="server-logs-panel"
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{m.agent_logs_title()}</h2>
            {availability.kind === "available" ? (
              phaseBadge(controller.phase)
            ) : availability.kind === "disabled" ? (
              <Badge variant="outline">
                {m.agent_logs_status_unavailable()}
              </Badge>
            ) : availability.kind === "offline" ? (
              <Badge variant="outline">{m.agent_logs_status_offline()}</Badge>
            ) : (
              <Badge variant="outline">
                {m.agent_logs_status_unsupported()}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {m.agent_logs_description()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              !available ||
              !availability.tail ||
              controller.phase === "unauthorized" ||
              controller.phase === "unavailable" ||
              controller.phase === "unsupported"
            }
            onClick={() => {
              if (controller.following) {
                controller.pause();
              } else {
                controller.resume();
              }
            }}
          >
            {controller.following ? <PauseIcon /> : <PlayIcon />}
            {controller.following
              ? m.agent_logs_action_pause()
              : m.agent_logs_action_resume()}
          </Button>
          <Button
            size="sm"
            variant="outline"
            loading={copying}
            disabled={selectedRecords.length === 0}
            onClick={() => void copySelected()}
          >
            <CopyIcon />
            {m.agent_logs_action_copy_selected({
              count: selectedRecords.length,
            })}
          </Button>
          {selectedRecords.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              <XIcon />
              {m.agent_logs_action_clear_selection()}
            </Button>
          ) : null}
        </div>
      </div>

      {availability.kind === "disabled" ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {m.agent_logs_unavailable_disabled()}
        </p>
      ) : availability.kind === "offline" ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {m.agent_logs_unavailable_offline()}
        </p>
      ) : availability.kind === "unsupported" ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {m.agent_logs_unavailable_unsupported()}
        </p>
      ) : controller.phase === "unauthorized" ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/24 bg-destructive/8 p-3 text-sm text-destructive-foreground"
        >
          {m.agent_logs_unauthorized_description()}
        </p>
      ) : controller.phase === "unavailable" ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {m.agent_logs_unavailable_disabled()}
        </p>
      ) : controller.phase === "unsupported" ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {m.agent_logs_unavailable_unsupported()}
        </p>
      ) : null}

      {availability.kind === "available" && !availability.tail ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {m.agent_logs_tail_unsupported()}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span id="agent-logs-source-label">
            {m.agent_logs_filter_source()}
          </span>
          <Select
            items={SOURCE_OPTIONS.map((source) => ({
              label:
                source === "all"
                  ? m.agent_logs_filter_source_all()
                  : source === "agent"
                    ? m.agent_logs_filter_source_agent()
                    : m.agent_logs_filter_source_sing_box(),
              value: source,
            }))}
            value={controller.filter.source ?? "all"}
            onValueChange={updateSource}
          >
            <SelectTrigger
              size="sm"
              className="w-40"
              aria-labelledby="agent-logs-source-label"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SOURCE_OPTIONS.map((source) => (
                <SelectItem key={source} value={source}>
                  {source === "all"
                    ? m.agent_logs_filter_source_all()
                    : source === "agent"
                      ? m.agent_logs_filter_source_agent()
                      : m.agent_logs_filter_source_sing_box()}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span id="agent-logs-level-label">{m.agent_logs_filter_level()}</span>
          <Select
            items={LEVEL_OPTIONS.map((level) => ({
              label: level,
              value: level,
            }))}
            value={controller.filter.minLevel ?? "trace"}
            onValueChange={updateLevel}
          >
            <SelectTrigger
              size="sm"
              className="w-32"
              aria-labelledby="agent-logs-level-label"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {LEVEL_OPTIONS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <p className="max-w-xl text-xs text-muted-foreground">
          {m.agent_logs_filter_note()}
        </p>
      </div>

      {availability.kind === "available" &&
      controller.tail.entries.length > 0 ? (
        <LogViewer
          entries={controller.tail.entries}
          following={controller.following}
          selected={selected}
          onToggleSelected={toggleSelected}
          onPause={controller.pause}
          onResume={controller.resume}
          onOpenContext={openEntry}
        />
      ) : controller.phase === "connecting" ||
        controller.phase === "reconnecting" ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 py-10 text-sm text-muted-foreground">
          <Spinner />
          {controller.phase === "connecting"
            ? m.agent_logs_status_connecting()
            : m.agent_logs_status_reconnecting()}
        </div>
      ) : tailEmpty && controller.tailError === null ? (
        <Empty className="rounded-lg border border-dashed py-10">
          <EmptyTitle>{m.agent_logs_empty_title()}</EmptyTitle>
          <EmptyDescription>
            {m.agent_logs_empty_description()}
          </EmptyDescription>
        </Empty>
      ) : null}

      {controller.phase === "reconnecting" &&
      controller.tail.entries.length > 0 ? (
        <p role="status" className="text-xs text-warning-foreground">
          {m.agent_logs_reconnecting_note()}
        </p>
      ) : null}
      {controller.tailError ? (
        <p role="alert" className="text-sm text-destructive">
          {logErrorMessage(controller.tailError)}
        </p>
      ) : null}
      {controller.tail.trimmed > 0 ? (
        <p className="text-xs text-muted-foreground">
          {m.agent_logs_view_trimmed({ count: controller.tail.trimmed })}
        </p>
      ) : controller.tail.hasOlder ? (
        <p className="text-xs text-muted-foreground">
          {m.agent_logs_older_available()}
        </p>
      ) : null}

      <form
        onSubmit={submitSearch}
        className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{m.agent_logs_search_title()}</h3>
          <p className="text-xs text-muted-foreground">
            {m.agent_logs_search_description()}
          </p>
        </div>
        {availability.kind !== "available" ? (
          <p className="text-sm text-muted-foreground">
            {m.agent_logs_search_unavailable()}
          </p>
        ) : !availability.search ? (
          <p className="text-sm text-muted-foreground">
            {m.agent_logs_search_unsupported()}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                {m.agent_logs_search_label()}
                <Input
                  type="search"
                  value={searchText}
                  maxLength={256}
                  placeholder={m.agent_logs_search_placeholder()}
                  onChange={(event) => setSearchText(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {m.agent_logs_search_from()}
                <Input
                  type="datetime-local"
                  value={since}
                  onChange={(event) => setSince(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {m.agent_logs_search_until()}
                <Input
                  type="datetime-local"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </label>
              <Button type="submit" size="sm">
                <SearchIcon />
                {m.agent_logs_action_search()}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clearSearch}
              >
                {m.agent_logs_action_clear_search()}
              </Button>
            </div>
            {rangeInvalid ? (
              <p role="alert" className="text-sm text-destructive">
                {m.agent_logs_search_invalid_range()}
              </p>
            ) : null}

            {controller.search.status === "searching" &&
            !controller.search.searchingMore ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Spinner />
                {m.agent_logs_search_running()}
              </div>
            ) : controller.search.status === "error" ? (
              <p role="alert" className="text-sm text-destructive">
                {logErrorMessage(controller.search.error)}
              </p>
            ) : controller.search.status === "complete" ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {m.agent_logs_search_results_count({
                      count: controller.search.results.length,
                    })}
                  </span>
                  <span>
                    {searchableRange(
                      controller.search.coverage?.searchableFrom ?? null,
                      controller.search.coverage?.searchableTo ?? null,
                    )}
                  </span>
                </div>
                {controller.search.incomplete ? (
                  <p
                    role="status"
                    className="rounded-md border border-warning/24 bg-warning/8 p-2 text-sm text-warning-foreground"
                  >
                    {m.agent_logs_search_incomplete()}
                  </p>
                ) : null}
                {searchEmpty ? (
                  <p className="py-3 text-sm text-muted-foreground">
                    {m.agent_logs_search_empty()}
                  </p>
                ) : (
                  <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                    {controller.search.results.map((record) => (
                      <SearchResultRow
                        key={record.seq}
                        record={record}
                        generation={searchGeneration}
                        query={lastSearchText}
                        onOpen={() => {
                          if (searchGeneration) {
                            controller.openContext(record, searchGeneration);
                          }
                        }}
                      />
                    ))}
                  </ul>
                )}
                {controller.search.next ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={controller.search.searchingMore}
                    onClick={controller.searchMore}
                  >
                    {m.agent_logs_action_load_more()}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </form>

      <LogContextDialog
        state={controller.context}
        query={lastSearchText}
        onClose={controller.closeContext}
      />
    </section>
  );
}
