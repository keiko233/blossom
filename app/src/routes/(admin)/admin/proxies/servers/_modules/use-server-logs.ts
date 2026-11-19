"use client";

import {
  AGENT_WS_V2_LOGS_LIMITS,
  parseAdminLogsServerFrame,
} from "@blossom/contracts/agent-ws-v2-logs";
import type {
  AdminLogsClientFrame,
  AdminLogsServerFrame,
  AgentWsV2LogCursor,
  AgentWsV2LogQuery,
  AgentWsV2LogRecord,
} from "@blossom/contracts/agent-ws-v2-logs";
import { useEffect, useRef, useState } from "react";

import {
  adminLogsFrameDestination,
  appendLogBatch,
  appendLogGap,
  applyLogSearchResult,
  beginLogSearch,
  emptyLogSearch,
  emptyLogTail,
  failLogSearch,
  type LogSearchState,
  type LogTailState,
} from "@/lib/admin-logs-view";

export type LogConnectionPhase =
  | "idle"
  | "connecting"
  | "live"
  | "paused"
  | "reconnecting"
  | "unauthorized"
  | "unavailable"
  | "unsupported"
  | "error";

export type LogFilter = Pick<AgentWsV2LogQuery, "source" | "minLevel">;

export interface LogSearchInput {
  text: string;
  since: string | null;
  until: string | null;
}

export type LogContextState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      generation: string;
      target: AgentWsV2LogRecord;
      before: AgentWsV2LogRecord[];
      after: AgentWsV2LogRecord[];
    };

export interface ServerLogsOptions {
  serverId: string;
  available: boolean;
  tailSupported: boolean;
  searchSupported: boolean;
}

export interface ServerLogsController {
  phase: LogConnectionPhase;
  following: boolean;
  filter: LogFilter;
  tail: LogTailState;
  tailError: string | null;
  search: LogSearchState;
  context: LogContextState | null;
  pause(): void;
  resume(): void;
  setFilter(filter: LogFilter): void;
  searchLogs(input: LogSearchInput): void;
  searchMore(): void;
  cancelSearch(): void;
  openContext(record: AgentWsV2LogRecord, generation: string): void;
  closeContext(): void;
}

const RECONNECT_MAX_MS = 15_000;
const CONTEXT_LINES = 20;

function socketUrl(serverId: string): string {
  const url = new URL(
    `/api/admin/servers/${encodeURIComponent(serverId)}/logs/ws`,
    window.location.href,
  );
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Owns one admin log WebSocket for the mounted Logs tab. Every handler also
 * checks its socket identity and epoch, so frames from a closed socket or a
 * replaced server cannot restore the previous view.
 */
export function useServerLogs({
  serverId,
  available,
  tailSupported,
  searchSupported,
}: ServerLogsOptions): ServerLogsController {
  const [phase, setPhase] = useState<LogConnectionPhase>("idle");
  const [following, setFollowing] = useState(true);
  const [filter, setFilterState] = useState<LogFilter>({});
  const [tail, setTail] = useState<LogTailState>(emptyLogTail);
  const [tailError, setTailError] = useState<string | null>(null);
  const [search, setSearch] = useState<LogSearchState>(emptyLogSearch);
  const [context, setContext] = useState<LogContextState | null>(null);

  const tailRef = useRef<LogTailState>(emptyLogTail);
  const socketRef = useRef<WebSocket | null>(null);
  const epochRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionRef = useRef<string | null>(null);
  const cursorRef = useRef<AgentWsV2LogCursor | null>(null);
  const filterRef = useRef<LogFilter>({});
  const followingRef = useRef(true);
  const searchRef = useRef<string | null>(null);
  const contextRef = useRef<string | null>(null);
  const searchInputRef = useRef<LogSearchInput>({
    text: "",
    since: null,
    until: null,
  });

  const replaceTail = (next: LogTailState) => {
    tailRef.current = next;
    cursorRef.current = next.cursor;
    setTail(next);
  };

  const sendFrame = (frame: AdminLogsClientFrame): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(
      JSON.stringify({
        v: 2,
        type: frame.type,
        ts: new Date().toISOString(),
        payload: frame.payload,
      }),
    );
    return true;
  };

  const beginTail = () => {
    if (!tailSupported) {
      return;
    }
    const subscriptionId = `sub-${crypto.randomUUID()}`;
    subscriptionRef.current = subscriptionId;
    sendFrame({
      type: "logs.subscribe",
      payload: {
        subscriptionId,
        filter: filterRef.current,
        resume: cursorRef.current,
        limit: AGENT_WS_V2_LOGS_LIMITS.subscribeDefaultRecords,
      },
    });
  };

  const unsubscribeTail = () => {
    const subscriptionId = subscriptionRef.current;
    if (!subscriptionId) {
      return;
    }
    sendFrame({
      type: "logs.unsubscribe",
      payload: { subscriptionId },
    });
    subscriptionRef.current = null;
  };

  const applyServerFrame = (frame: AdminLogsServerFrame) => {
    const destination = adminLogsFrameDestination(frame, {
      subscriptionId: subscriptionRef.current,
      searchRequestId: searchRef.current,
      contextRequestId: contextRef.current,
    });
    if (destination === "ignored") {
      return;
    }
    switch (frame.type) {
      case "logs.batch": {
        replaceTail(appendLogBatch(tailRef.current, frame.payload));
        setTailError(null);
        return;
      }
      case "logs.gap": {
        replaceTail(appendLogGap(tailRef.current, frame.payload));
        return;
      }
      case "logs.search.result": {
        searchRef.current = null;
        setSearch((previous) => applyLogSearchResult(previous, frame.payload));
        return;
      }
      case "logs.context.result": {
        contextRef.current = null;
        setContext({
          status: "ready",
          generation: frame.payload.generation,
          target: frame.payload.target,
          before: frame.payload.before,
          after: frame.payload.after,
        });
        return;
      }
      case "logs.error": {
        const { code } = frame.payload;
        if (destination === "tail") {
          setTailError(code);
          return;
        }
        if (destination === "search") {
          searchRef.current = null;
          setSearch((previous) => failLogSearch(previous, code));
          return;
        }
        if (destination === "context") {
          contextRef.current = null;
          setContext({ status: "error", error: code });
        }
        return;
      }
    }
  };

  useEffect(() => {
    if (!available) {
      setPhase("idle");
      return;
    }

    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    let attempt = 0;
    let disposed = false;
    setPhase("connecting");

    const isCurrent = (socket: WebSocket) =>
      !disposed && epochRef.current === epoch && socketRef.current === socket;

    function scheduleReconnect() {
      if (disposed || epochRef.current !== epoch) {
        return;
      }
      attempt += 1;
      const delay = Math.min(
        1_000 * 2 ** Math.min(attempt - 1, 4),
        RECONNECT_MAX_MS,
      );
      setPhase("reconnecting");
      retryRef.current = setTimeout(connect, delay);
    }

    function connect() {
      if (disposed || epochRef.current !== epoch) {
        return;
      }
      const socket = new WebSocket(socketUrl(serverId));
      socketRef.current = socket;

      socket.onopen = () => {
        if (!isCurrent(socket)) {
          return;
        }
        attempt = 0;
        if (followingRef.current) {
          setPhase("live");
          beginTail();
        } else {
          setPhase("paused");
        }
      };

      socket.onmessage = (event) => {
        if (!isCurrent(socket) || typeof event.data !== "string") {
          return;
        }
        const parsed = parseAdminLogsServerFrame(event.data);
        if (parsed.ok) {
          applyServerFrame(parsed.frame);
        }
      };

      socket.onerror = () => {
        // The close event carries the actionable state.
      };

      socket.onclose = (event) => {
        if (!isCurrent(socket)) {
          return;
        }
        socketRef.current = null;
        subscriptionRef.current = null;
        searchRef.current = null;
        contextRef.current = null;

        if (event.code === 1000) {
          setPhase("idle");
          return;
        }
        if (event.code === 4001) {
          setPhase("unauthorized");
          return;
        }
        if (event.code === 4002) {
          setPhase("unavailable");
          return;
        }
        if (event.code === 4005) {
          setPhase("unsupported");
          return;
        }
        if (event.code === 1008 || event.code === 1009) {
          setPhase("error");
          return;
        }
        // 4003 (session replaced), 4004 (offline) and abnormal closes recover
        // through a fresh handshake; the agent resumes from the last cursor.
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      disposed = true;
      epochRef.current = epoch + 1;
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      subscriptionRef.current = null;
      searchRef.current = null;
      contextRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        socket.close(1000, "view_closed");
      }
    };
    // WebSocket handlers read filters, cursor and following through refs; the
    // connection itself only changes with the server or its capabilities.
  }, [serverId, available, tailSupported, searchSupported]);

  const pause = () => {
    followingRef.current = false;
    setFollowing(false);
    unsubscribeTail();
    setPhase((current) =>
      current === "live" || current === "paused" ? "paused" : current,
    );
  };

  const resume = () => {
    followingRef.current = true;
    setFollowing(true);
    setPhase((current) =>
      current === "unauthorized" ||
      current === "unavailable" ||
      current === "unsupported" ||
      current === "error"
        ? current
        : socketRef.current?.readyState === WebSocket.OPEN
          ? "live"
          : socketRef.current?.readyState === WebSocket.CONNECTING
            ? "connecting"
            : "idle",
    );
    beginTail();
  };

  const setFilter = (next: LogFilter) => {
    filterRef.current = next;
    setFilterState(next);
    unsubscribeTail();
    cursorRef.current = null;
    replaceTail(emptyLogTail);
    setTailError(null);
    if (searchRef.current) {
      sendFrame({
        type: "logs.search.cancel",
        payload: { requestId: searchRef.current },
      });
      searchRef.current = null;
    }
    setSearch(emptyLogSearch);
    contextRef.current = null;
    setContext(null);
    if (followingRef.current) {
      beginTail();
    }
  };

  const submitSearch = (mode: "replace" | "more") => {
    if (!searchSupported) {
      setSearch((previous) =>
        failLogSearch(previous, "unsupported_capability"),
      );
      return;
    }
    const requestId = `search-${crypto.randomUUID()}`;
    if (searchRef.current) {
      sendFrame({
        type: "logs.search.cancel",
        payload: { requestId: searchRef.current },
      });
    }
    searchRef.current = requestId;
    setSearch((previous) => beginLogSearch(previous, requestId, mode));

    const input = searchInputRef.current;
    const query: AgentWsV2LogQuery = {
      ...filterRef.current,
      ...(input.text.trim() ? { text: input.text.trim() } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
    };
    const sent = sendFrame({
      type: "logs.search",
      payload: {
        requestId,
        query,
        cursor: mode === "more" ? search.next : null,
        limit: AGENT_WS_V2_LOGS_LIMITS.searchPageMax,
      },
    });
    if (!sent) {
      searchRef.current = null;
      setSearch((previous) => failLogSearch(previous, "offline"));
    }
  };

  const searchLogs = (input: LogSearchInput) => {
    searchInputRef.current = input;
    submitSearch("replace");
  };

  const searchMore = () => {
    if (!search.next) {
      return;
    }
    submitSearch("more");
  };

  const cancelSearch = () => {
    if (searchRef.current) {
      sendFrame({
        type: "logs.search.cancel",
        payload: { requestId: searchRef.current },
      });
      searchRef.current = null;
    }
    setSearch(emptyLogSearch);
  };

  const openContext = (record: AgentWsV2LogRecord, generation: string) => {
    if (!searchSupported) {
      setContext({ status: "error", error: "unsupported_capability" });
      return;
    }
    const requestId = `ctx-${crypto.randomUUID()}`;
    contextRef.current = requestId;
    setContext({ status: "loading" });
    const sent = sendFrame({
      type: "logs.context",
      payload: {
        requestId,
        generation,
        seq: record.seq,
        before: CONTEXT_LINES,
        after: CONTEXT_LINES,
      },
    });
    if (!sent) {
      contextRef.current = null;
      setContext({ status: "error", error: "offline" });
    }
  };

  const closeContext = () => {
    contextRef.current = null;
    setContext(null);
  };

  return {
    phase,
    following,
    filter,
    tail,
    tailError,
    search,
    context,
    pause,
    resume,
    setFilter,
    searchLogs,
    searchMore,
    cancelSearch,
    openContext,
    closeContext,
  };
}
