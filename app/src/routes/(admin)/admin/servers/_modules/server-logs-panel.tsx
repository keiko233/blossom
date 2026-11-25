"use client";

import type {
  AgentWsV2LogLevel,
  AgentWsV2LogSource,
} from "@blossom/contracts/agent-ws-v2-logs";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import {
  WorkbenchBody,
  WorkbenchCanvas,
} from "@/components/app-shell/workspace";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import {
  formatLogLine,
  isLogRecordEntry,
  logAvailability,
  logPolicyToolbarTone,
  type LogViewEntry,
} from "@/lib/admin-logs-view";
import { resultsPlacement } from "@/lib/log-view-format";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { LogContextDialog } from "./log-context-dialog";
import { logErrorMessage } from "./log-error-message";
import { LogSearchResults } from "./log-search-results";
import { LogViewer } from "./log-viewer";
import { LogsSearchBar } from "./logs-search-bar";
import { LogsStatusBar } from "./logs-status-bar";
import { LogsToolbar } from "./logs-toolbar";
import { serverLogPolicyCues } from "./server-log-policy-panel";
import { ServerLogPolicySheet } from "./server-log-policy-sheet";
import { useServerList } from "./use-server-list";
import { useServerLogPolicy } from "./use-server-log-policy";
import { useServerLogs } from "./use-server-logs";

export interface ServerLogsPanelProps {
  server: ServerDTO;
}

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

/**
 * The Logs tab as a full-bleed workbench: toolbar, optional search bar, a
 * virtualized canvas that owns its scroll, retained-search results beside it,
 * and a status bar. Query text and records live only in component state;
 * nothing is written to the URL or browser storage.
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
  const policy = useServerLogPolicy(server.id);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [rangeInvalid, setRangeInvalid] = useState(false);
  const [lastSearchText, setLastSearchText] = useState("");
  const [copying, setCopying] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const [policyOpen, setPolicyOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);

  useEffect(() => {
    setSelected(new Set());
  }, [server.id, controller.filter.source, controller.filter.minLevel]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        if (availability.kind === "available" && availability.search) {
          event.preventDefault();
          setSearchOpen(true);
          setSearchFocusNonce((nonce) => nonce + 1);
        }
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [availability]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setPaneWidth(entry.contentRect.width);
      }
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const recordEntries = controller.tail.entries.filter(isLogRecordEntry);
  const selectedRecords = recordEntries.filter((entry) =>
    selected.has(entry.id),
  );

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

  const closeSearchBar = () => {
    setSearchOpen(false);
    clearSearch();
  };

  const openEntry = (entry: Extract<LogViewEntry, { kind: "record" }>) => {
    controller.openContext(entry.record, entry.generation);
  };

  const focusSearch = () => {
    if (availability.kind === "available" && availability.search) {
      setSearchOpen(true);
      setSearchFocusNonce((nonce) => nonce + 1);
    }
  };

  const tailSupported = availability.kind === "available" && availability.tail;
  const searchSupported =
    availability.kind === "available" && availability.search;
  const followDisabled =
    !tailSupported ||
    controller.phase === "unauthorized" ||
    controller.phase === "unavailable" ||
    controller.phase === "unsupported";
  const searchActive = controller.search.status !== "idle";
  const placement = resultsPlacement(paneWidth);
  const policyTone = logPolicyToolbarTone(serverLogPolicyCues(live, policy));
  const tailEmpty =
    availability.kind === "available" &&
    availability.tail &&
    controller.tail.entries.length === 0 &&
    controller.phase !== "connecting" &&
    controller.phase !== "reconnecting";

  return (
    <section
      ref={rootRef}
      data-slot="server-logs-panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label={m.agent_logs_title()}
    >
      <LogsToolbar
        following={controller.following}
        followDisabled={followDisabled}
        controlsDisabled={!available}
        source={controller.filter.source}
        minLevel={controller.filter.minLevel}
        onUpdateSource={updateSource}
        onUpdateLevel={updateLevel}
        onFollowChange={(pressed) => {
          if (pressed) {
            controller.resume();
          } else {
            controller.pause();
          }
        }}
        searchOpen={searchOpen}
        searchDisabled={!searchSupported}
        onToggleSearch={() => {
          if (searchOpen) {
            setSearchOpen(false);
          } else {
            setSearchOpen(true);
            setSearchFocusNonce((nonce) => nonce + 1);
          }
        }}
        policyTone={policyTone}
        onOpenPolicy={() => setPolicyOpen(true)}
        selectedCount={selectedRecords.length}
        copying={copying}
        onCopy={() => void copySelected()}
        onClearSelection={() => setSelected(new Set())}
      />

      {searchOpen ? (
        <LogsSearchBar
          query={searchText}
          onQueryChange={setSearchText}
          since={since}
          onSinceChange={setSince}
          until={until}
          onUntilChange={setUntil}
          rangeInvalid={rangeInvalid}
          onSubmit={submitSearch}
          onClose={closeSearchBar}
          disabled={!searchSupported}
          focusNonce={searchFocusNonce}
        />
      ) : null}

      <WorkbenchBody className="flex-col xl:flex-row">
        <WorkbenchCanvas className="flex flex-col">
          <LogCanvas
            availability={availability}
            controller={controller}
            selected={selected}
            tailEmpty={tailEmpty}
            onToggleSelected={toggleSelected}
            onOpen={openEntry}
            onFocusSearch={focusSearch}
          />
        </WorkbenchCanvas>

        {searchActive ? (
          <LogSearchResults
            search={controller.search}
            query={lastSearchText}
            placement={placement}
            onOpen={(record, generation) =>
              controller.openContext(record, generation)
            }
            onLoadMore={controller.searchMore}
            onClose={controller.cancelSearch}
          />
        ) : null}
      </WorkbenchBody>

      <LogsStatusBar
        phase={controller.phase}
        tailError={controller.tailError}
        lineCount={controller.tail.entries.length}
        trimmed={controller.tail.trimmed}
        selectedCount={selectedRecords.length}
      />

      <ServerLogPolicySheet
        server={live}
        controller={policy}
        open={policyOpen}
        onOpenChange={setPolicyOpen}
      />

      <LogContextDialog
        state={controller.context}
        query={lastSearchText}
        onClose={controller.closeContext}
      />
    </section>
  );
}

function LogCanvas({
  availability,
  controller,
  selected,
  tailEmpty,
  onToggleSelected,
  onOpen,
  onFocusSearch,
}: {
  availability: ReturnType<typeof logAvailability>;
  controller: ReturnType<typeof useServerLogs>;
  selected: ReadonlySet<string>;
  tailEmpty: boolean;
  onToggleSelected(entryId: string): void;
  onOpen(entry: Extract<LogViewEntry, { kind: "record" }>): void;
  onFocusSearch(): void;
}): React.ReactElement {
  const unavailable = logCanvasUnavailable(availability, controller.phase);

  if (unavailable) {
    return (
      <Empty className="p-6">
        <EmptyTitle className="text-base">{unavailable.title}</EmptyTitle>
        <EmptyDescription>
          <span role={unavailable.alert ? "alert" : undefined}>
            {unavailable.description}
          </span>
        </EmptyDescription>
      </Empty>
    );
  }

  if (availability.kind === "available" && !availability.tail) {
    return (
      <Empty className="p-6">
        <EmptyTitle className="text-base">
          {m.agent_logs_status_unsupported()}
        </EmptyTitle>
        <EmptyDescription>{m.agent_logs_tail_unsupported()}</EmptyDescription>
      </Empty>
    );
  }

  if (controller.tail.entries.length > 0) {
    return (
      <LogViewer
        entries={controller.tail.entries}
        following={controller.following}
        selected={selected}
        onToggleSelected={onToggleSelected}
        onPause={controller.pause}
        onResume={controller.resume}
        onOpenContext={onOpen}
        onFocusSearch={onFocusSearch}
      />
    );
  }

  if (
    controller.phase === "connecting" ||
    controller.phase === "reconnecting"
  ) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="flex flex-1 flex-col gap-2 overflow-hidden p-2 font-mono"
      >
        <span className="sr-only">{m.admin_ui_loading()}</span>
        {Array.from({ length: 18 }, (_, row) => (
          <Skeleton
            key={row}
            className={
              row % 3 === 0
                ? "h-3 w-4/5"
                : row % 3 === 1
                  ? "h-3 w-full"
                  : "h-3 w-3/5"
            }
          />
        ))}
      </div>
    );
  }

  if (tailEmpty && controller.tailError === null) {
    return (
      <Empty className="p-6">
        <EmptyTitle className="text-base">
          {m.agent_logs_empty_title()}
        </EmptyTitle>
        <EmptyDescription>{m.agent_logs_empty_description()}</EmptyDescription>
      </Empty>
    );
  }

  if (controller.tailError) {
    return (
      <Empty className="p-6">
        <EmptyTitle className="text-base">
          {m.agent_logs_status_error()}
        </EmptyTitle>
        <EmptyDescription>
          {logErrorMessage(controller.tailError)}
        </EmptyDescription>
      </Empty>
    );
  }

  return <div className="flex-1" />;
}

interface LogCanvasUnavailable {
  title: string;
  description: string;
  alert: boolean;
}

/**
 * One compact message for every state that cannot stream tail lines. A denied
 * session or connection error is announced as an alert; the rest stay polite.
 */
function logCanvasUnavailable(
  availability: ReturnType<typeof logAvailability>,
  phase: ReturnType<typeof useServerLogs>["phase"],
): LogCanvasUnavailable | null {
  if (availability.kind === "disabled") {
    return {
      title: m.agent_logs_status_unavailable(),
      description: m.agent_logs_unavailable_disabled(),
      alert: false,
    };
  }
  if (availability.kind === "offline") {
    return {
      title: m.agent_logs_status_offline(),
      description: m.agent_logs_unavailable_offline(),
      alert: false,
    };
  }
  if (availability.kind === "unsupported") {
    return {
      title: m.agent_logs_status_unsupported(),
      description: m.agent_logs_unavailable_unsupported(),
      alert: false,
    };
  }
  switch (phase) {
    case "unauthorized":
      return {
        title: m.agent_logs_status_unauthorized(),
        description: m.agent_logs_unauthorized_description(),
        alert: true,
      };
    case "unavailable":
      return {
        title: m.agent_logs_status_unavailable(),
        description: m.agent_logs_unavailable_disabled(),
        alert: false,
      };
    case "unsupported":
      return {
        title: m.agent_logs_status_unsupported(),
        description: m.agent_logs_unavailable_unsupported(),
        alert: false,
      };
    case "error":
      return {
        title: m.agent_logs_status_error(),
        description: m.agent_logs_error_generic(),
        alert: true,
      };
    default:
      return null;
  }
}
