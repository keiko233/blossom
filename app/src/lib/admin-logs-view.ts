import {
  AGENT_WS_V2_LOGS_SEARCH_CAPABILITY,
  AGENT_WS_V2_LOGS_TAIL_CAPABILITY,
} from "@blossom/contracts/agent-ws-v2-logs";
import type {
  AdminLogsServerFrame,
  AgentWsV2LogCoverage,
  AgentWsV2LogCursor,
  AgentWsV2LogGap,
  AgentWsV2LogRecord,
  AgentWsV2LogSearchCursor,
  AgentWsV2LogsPayloadOf,
} from "@blossom/contracts/agent-ws-v2-logs";

import type { LogPolicyCue } from "@/lib/log-policy-view";

type AgentWsV2LogsBatchPayload = AgentWsV2LogsPayloadOf<"logs.batch">;
type AgentWsV2LogsSearchResultPayload =
  AgentWsV2LogsPayloadOf<"logs.search.result">;

/** The browser wire adds a control-plane `dropped` gap to agent gaps. */
export type BrowserLogGapPayload = {
  subscriptionId: string;
  generation: string;
  gap: AgentWsV2LogGap | { reason: "dropped"; fromSeq: number; toSeq: number };
};

/**
 * Browser-side retained window. The agent owns the authoritative ring buffer;
 * this state only keeps the most recent lines a viewer can render, so the DOM
 * and memory stay bounded even when a subscription outlives the tab's needs.
 */
export const LOG_VIEW_MAX_ENTRIES = 4_000;

export type LogGapReason = AgentWsV2LogGap["reason"] | "dropped";

export type LogViewEntry =
  | {
      kind: "record";
      id: string;
      generation: string;
      record: AgentWsV2LogRecord;
    }
  | {
      kind: "gap";
      id: string;
      generation: string;
      reason: LogGapReason;
      fromSeq: number;
      toSeq: number;
    };

export interface LogTailState {
  entries: LogViewEntry[];
  cursor: AgentWsV2LogCursor | null;
  generation: string | null;
  lastSeq: number;
  /** The agent has older retained records beyond the first page. */
  hasOlder: boolean;
  /** Entries the browser dropped from the front of its own window. */
  trimmed: number;
}

export const emptyLogTail: LogTailState = {
  entries: [],
  cursor: null,
  generation: null,
  lastSeq: 0,
  hasOlder: false,
  trimmed: 0,
};

export type AdminLogsFrameDestination =
  | "tail"
  | "search"
  | "context"
  | "ignored";

/**
 * Routes a relay result to the request that is still current on this socket.
 * Late results for a replaced subscription, search or server are ignored.
 */
export function adminLogsFrameDestination(
  frame: AdminLogsServerFrame,
  ids: {
    subscriptionId: string | null;
    searchRequestId: string | null;
    contextRequestId: string | null;
  },
): AdminLogsFrameDestination {
  switch (frame.type) {
    case "logs.batch":
    case "logs.gap":
      return frame.payload.subscriptionId === ids.subscriptionId
        ? "tail"
        : "ignored";
    case "logs.search.result":
      return frame.payload.requestId === ids.searchRequestId
        ? "search"
        : "ignored";
    case "logs.context.result":
      return frame.payload.requestId === ids.contextRequestId
        ? "context"
        : "ignored";
    case "logs.error": {
      const { subscriptionId, requestId } = frame.payload;
      if (subscriptionId && subscriptionId === ids.subscriptionId) {
        return "tail";
      }
      if (requestId && requestId === ids.searchRequestId) {
        return "search";
      }
      if (requestId && requestId === ids.contextRequestId) {
        return "context";
      }
      return "ignored";
    }
  }
}

export function logRecordId(generation: string, seq: number): string {
  return `record:${generation}:${seq}`;
}

export function logGapId(
  generation: string,
  reason: LogGapReason,
  fromSeq: number,
  toSeq: number,
): string {
  return `gap:${generation}:${reason}:${fromSeq}:${toSeq}`;
}

function trimEntries(entries: LogViewEntry[]): {
  entries: LogViewEntry[];
  trimmed: number;
} {
  const overflow = entries.length - LOG_VIEW_MAX_ENTRIES;
  if (overflow <= 0) {
    return { entries, trimmed: 0 };
  }
  return { entries: entries.slice(overflow), trimmed: overflow };
}

function restartGap(generation: string): LogViewEntry {
  return {
    kind: "gap",
    id: logGapId(generation, "restarted", 0, 0),
    generation,
    reason: "restarted",
    fromSeq: 0,
    toSeq: 0,
  };
}

/**
 * Merges one tail batch in arrival order. A generation change without a gap is
 * treated as an agent restart, and records at or below the last accepted
 * sequence are ignored so a retried batch cannot duplicate or rewind the view.
 */
export function appendLogBatch(
  state: LogTailState,
  payload: AgentWsV2LogsBatchPayload,
): LogTailState {
  const generation = payload.next.generation;
  let entries = state.entries;
  let lastSeq = state.lastSeq;

  if (state.generation !== null && state.generation !== generation) {
    entries = [...entries, restartGap(generation)];
    lastSeq = 0;
  }

  for (const record of payload.records) {
    if (state.generation === generation && record.seq <= lastSeq) {
      continue;
    }
    entries = [
      ...entries,
      {
        kind: "record",
        id: logRecordId(generation, record.seq),
        generation,
        record,
      },
    ];
    lastSeq = record.seq;
  }

  const trimmed = trimEntries(entries);
  return {
    entries: trimmed.entries,
    cursor: payload.next,
    generation,
    lastSeq,
    hasOlder: state.hasOlder || payload.hasMore,
    trimmed: state.trimmed + trimmed.trimmed,
  };
}

/**
 * Adds a visible gap. Overwritten ranges are deduplicated; a restart keeps the
 * previous generation's lines visible and marks where the buffer restarted.
 */
export function appendLogGap(
  state: LogTailState,
  payload: BrowserLogGapPayload,
): LogTailState {
  const { generation, gap } = payload;
  const id = logGapId(generation, gap.reason, gap.fromSeq, gap.toSeq);
  if (state.entries.some((entry) => entry.kind === "gap" && entry.id === id)) {
    return state;
  }

  const entry: LogViewEntry = {
    kind: "gap",
    id,
    generation,
    reason: gap.reason,
    fromSeq: gap.fromSeq,
    toSeq: gap.toSeq,
  };
  const entries = [...state.entries, entry];
  const trimmed = trimEntries(entries);

  if (gap.reason === "restarted") {
    // Resume from the newest page because the previous generation is gone.
    return {
      entries: trimmed.entries,
      cursor: null,
      generation,
      lastSeq: 0,
      hasOlder: false,
      trimmed: state.trimmed + trimmed.trimmed,
    };
  }

  return {
    entries: trimmed.entries,
    cursor:
      state.generation === generation && state.cursor
        ? { generation, seq: Math.max(state.cursor.seq, gap.toSeq) }
        : { generation, seq: gap.toSeq },
    generation,
    lastSeq:
      state.generation === generation ? Math.max(state.lastSeq, gap.toSeq) : 0,
    hasOlder: state.hasOlder,
    trimmed: state.trimmed + trimmed.trimmed,
  };
}

export function isLogRecordEntry(
  entry: LogViewEntry,
): entry is Extract<LogViewEntry, { kind: "record" }> {
  return entry.kind === "record";
}

export type LogSearchStatus = "idle" | "searching" | "complete" | "error";

export interface LogSearchState {
  status: LogSearchStatus;
  requestId: string | null;
  generation: string | null;
  results: AgentWsV2LogRecord[];
  coverage: AgentWsV2LogCoverage | null;
  next: AgentWsV2LogSearchCursor | null;
  incomplete: boolean;
  searchingMore: boolean;
  error: string | null;
}

export const emptyLogSearch: LogSearchState = {
  status: "idle",
  requestId: null,
  generation: null,
  results: [],
  coverage: null,
  next: null,
  incomplete: false,
  searchingMore: false,
  error: null,
};

export function beginLogSearch(
  state: LogSearchState,
  requestId: string,
  mode: "replace" | "more",
): LogSearchState {
  if (mode === "more") {
    return {
      ...state,
      status: "searching",
      requestId,
      searchingMore: true,
      error: null,
    };
  }
  return {
    status: "searching",
    requestId,
    generation: null,
    results: [],
    coverage: null,
    next: null,
    incomplete: false,
    searchingMore: false,
    error: null,
  };
}

/**
 * Applies the page the browser's current request asked for. Results stay
 * newest first and are deduplicated by sequence within the pinned generation.
 */
export function applyLogSearchResult(
  state: LogSearchState,
  payload: AgentWsV2LogsSearchResultPayload,
): LogSearchState {
  const seen = new Set(state.results.map((record) => record.seq));
  const incoming = payload.matches.filter((record) => !seen.has(record.seq));
  const results = [...state.results, ...incoming].sort(
    (left, right) => right.seq - left.seq,
  );

  return {
    status: "complete",
    requestId: payload.requestId,
    generation: payload.generation,
    results,
    coverage: payload.coverage,
    next: payload.next,
    incomplete: payload.coverage.gap !== null,
    searchingMore: false,
    error: null,
  };
}

export function failLogSearch(
  state: LogSearchState,
  message: string,
): LogSearchState {
  return {
    ...state,
    status: "error",
    searchingMore: false,
    error: message,
  };
}

export type LogAvailability =
  | { kind: "available"; tail: boolean; search: boolean }
  | { kind: "disabled" }
  | { kind: "offline" }
  | { kind: "unsupported" };

export interface LogAvailabilityInput {
  enabled: boolean;
  transportMode: string;
  wsConnectedAt: unknown;
  agentCapabilities: readonly string[] | null;
}

/**
 * The same gate the relay applies, so the tab shows a specific unavailable
 * state instead of attempting an upgrade it knows will be refused.
 */
export function logAvailability(input: LogAvailabilityInput): LogAvailability {
  if (!input.enabled) {
    return { kind: "disabled" };
  }
  if (input.transportMode !== "ws" || !input.wsConnectedAt) {
    return { kind: "offline" };
  }
  const capabilities = input.agentCapabilities ?? [];
  const tail = capabilities.includes(AGENT_WS_V2_LOGS_TAIL_CAPABILITY);
  const search = capabilities.includes(AGENT_WS_V2_LOGS_SEARCH_CAPABILITY);
  return tail || search
    ? { kind: "available", tail, search }
    : { kind: "unsupported" };
}

function isControlCodePoint(code: number): boolean {
  return (
    (code >= 0 && code <= 8) ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    (code >= 127 && code <= 159)
  );
}

/**
 * Defense in depth: the agent strips control characters at the source, and the
 * browser removes any that still arrive before text reaches Shiki or the DOM.
 */
export function sanitizeLogText(text: string): string {
  let sanitized = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    sanitized +=
      code !== undefined && isControlCodePoint(code) ? "\uFFFD" : character;
  }
  return sanitized;
}

/** Sanitized, single-line text for both rendering and clipboard output. */
export function logTextForDisplay(text: string): string {
  return sanitizeLogText(text).replace(/\r\n?|\n/g, " \u21B5 ");
}

/** One selected line as copied to the clipboard; the agent already redacted it. */
export function formatLogLine(record: AgentWsV2LogRecord): string {
  const truncated = record.truncated ? " [truncated]" : "";
  return `${record.time} [${record.source}] [${record.level.toUpperCase()}] ${logTextForDisplay(record.text)}${truncated}`;
}

export interface LogMatchPart {
  text: string;
  match: boolean;
}

/**
 * Splits sanitized text at case-insensitive literal matches without building a
 * regular expression from operator input.
 */
export function splitLogMatch(text: string, query: string): LogMatchPart[] {
  const safeText = logTextForDisplay(text);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [{ text: safeText, match: false }];
  }

  const haystack = safeText.toLowerCase();
  const parts: LogMatchPart[] = [];
  let cursor = 0;

  while (cursor < safeText.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      parts.push({ text: safeText.slice(cursor), match: false });
      break;
    }
    if (index > cursor) {
      parts.push({ text: safeText.slice(cursor, index), match: false });
    }
    parts.push({
      text: safeText.slice(index, index + needle.length),
      match: true,
    });
    cursor = index + needle.length;
  }

  return parts.length > 0 ? parts : [{ text: safeText, match: false }];
}

/**
 * Moves the active log row for the list's keyboard navigation. Returns null
 * for keys the list does not handle so the event keeps its normal meaning.
 */
export function nextLogIndex(
  key: string,
  current: number,
  count: number,
  pageSize = 10,
): number | null {
  if (count <= 0) {
    return null;
  }
  const clamp = (index: number) => Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowDown":
      return clamp(current + 1);
    case "ArrowUp":
      return clamp(current - 1);
    case "PageDown":
      return clamp(current + pageSize);
    case "PageUp":
      return clamp(current - pageSize);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** A short UTC time for a fixed-height row; the title carries the full value. */
export function logTimeLabel(iso: string): string {
  return iso.slice(11, 23);
}

/** Status-dot tone for the workbench status bar. */
export type LogPhaseTone = "success" | "warning" | "info" | "danger" | "muted";

/**
 * A connection phase is never communicated by color alone; the status bar
 * always renders its label next to this dot.
 */
export function logPhaseTone(
  phase:
    | "idle"
    | "connecting"
    | "live"
    | "paused"
    | "reconnecting"
    | "unauthorized"
    | "unavailable"
    | "unsupported"
    | "error",
): LogPhaseTone {
  switch (phase) {
    case "live":
      return "success";
    case "paused":
    case "reconnecting":
      return "warning";
    case "connecting":
      return "info";
    case "unauthorized":
    case "error":
      return "danger";
    case "idle":
    case "unavailable":
    case "unsupported":
      return "muted";
  }
}

/** Most urgent cue shown on the toolbar's policy button, if any. */
export type LogPolicyToolbarTone = "danger" | "info" | "warning" | null;

/**
 * Collapses every source's cues into one toolbar signal: an apply error
 * outranks an in-flight apply, which outranks a pending acknowledgement.
 */
export function logPolicyToolbarTone(
  cues: readonly LogPolicyCue[],
): LogPolicyToolbarTone {
  if (cues.includes("error")) {
    return "danger";
  }
  if (cues.includes("applying")) {
    return "info";
  }
  if (cues.includes("pending")) {
    return "warning";
  }
  return null;
}
