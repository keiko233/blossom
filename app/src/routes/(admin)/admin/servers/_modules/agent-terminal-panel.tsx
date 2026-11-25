"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";

import {
  XtermTerminal,
  type XtermTerminalHandle,
} from "@/components/terminal/xterm-terminal";
import { Confirm } from "@/components/ui/confirm";
import { PTY_OPEN_TIMEOUT_MS } from "@/lib/pty-protocol";
import {
  clampTerminalFontSize,
  readTerminalFontSize,
  TERMINAL_FONT_SIZE,
  type TerminalPhase,
  writeTerminalFontSize,
} from "@/lib/terminal-view";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { TerminalEmptyState } from "./terminal-empty-state";
import {
  TerminalSessionBar,
  type TerminalIdentity,
} from "./terminal-session-bar";
import { TerminalStatusBar } from "./terminal-status-bar";

export interface AgentTerminalPanelProps {
  server: ServerDTO;
}

interface ServerFrame {
  type?: string;
  payload?: {
    sessionId?: string;
    data?: string;
    reason?: string;
    code?: number;
    signal?: string;
    detail?: string;
    shell?: string;
    user?: string;
  };
}

type ProbeResult =
  | { kind: "ready" }
  | { kind: "denied" }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed" };

const MAX_BUFFERED_OUTPUT = 1024 * 1024;
const MAX_BROWSER_BACKLOG = 4 * 1024 * 1024;

function parseServerFrame(raw: string): ServerFrame | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null
      ? (value as ServerFrame)
      : null;
  } catch {
    return null;
  }
}

function unavailableMessage(reason: string): string {
  switch (reason) {
    case "disabled":
      return m.agent_terminal_unavailable_disabled();
    case "offline":
      return m.agent_terminal_unavailable_offline();
    case "unsupported":
      return m.agent_terminal_unavailable_unsupported();
    default:
      return m.agent_terminal_notice_probe_failed();
  }
}

/**
 * Asks the control plane whether a terminal can open before a socket is
 * created. A failed WebSocket handshake hides its HTTP status from the
 * browser, so denial is detected here instead.
 */
async function probeTerminal(serverId: string): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(
      `/api/admin/servers/${encodeURIComponent(serverId)}/pty/status`,
      { cache: "no-store", credentials: "same-origin" },
    );
  } catch {
    return { kind: "failed" };
  }
  if (response.status === 403) {
    return { kind: "denied" };
  }
  if (!response.ok) {
    return { kind: "failed" };
  }
  const body = (await response.json().catch(() => null)) as {
    available?: boolean;
    reason?: string;
  } | null;
  return body?.available
    ? { kind: "ready" }
    : { kind: "unavailable", reason: body?.reason ?? "" };
}

function probeNotice(probe: ProbeResult): string {
  switch (probe.kind) {
    case "denied":
      return m.agent_terminal_notice_denied();
    case "unavailable":
      return unavailableMessage(probe.reason);
    default:
      return m.agent_terminal_notice_probe_failed();
  }
}

/** Explains why a session ended. Startup reasons carry the agent's detail. */
function exitNotice(payload: ServerFrame["payload"]): string {
  const reason = payload?.reason ?? "closed";
  const detail = payload?.detail ?? "";
  switch (reason) {
    case "shell_unavailable":
      return m.agent_terminal_reason_shell_unavailable({ detail });
    case "pty_unavailable":
      return m.agent_terminal_reason_pty_unavailable({ detail });
    case "spawn_failed":
      return m.agent_terminal_reason_spawn_failed({ detail });
    case "relay_timeout":
      return m.agent_terminal_reason_relay_timeout();
    case "authorization_revoked":
      return m.agent_terminal_reason_authorization_revoked();
    case "session_limit":
      return m.agent_terminal_reason_session_limit();
    case "idle_timeout":
      return m.agent_terminal_reason_idle_timeout();
    case "session_expired":
      return m.agent_terminal_reason_session_expired();
    case "disabled":
      return m.agent_terminal_reason_disabled();
    case "shell_exit":
      return payload?.code === undefined
        ? m.agent_terminal_exit_reason({ reason })
        : m.agent_terminal_reason_shell_exit({ code: String(payload.code) });
    default:
      return m.agent_terminal_exit_reason({ reason });
  }
}

/**
 * The browser half of the agent terminal. A session is created only after an
 * explicit admin confirmation; the control plane authenticates the WebSocket
 * upgrade and relays it to the already-enrolled agent. The terminal is shown
 * as connected only after the agent reports that its shell started.
 */
export function AgentTerminalPanel({
  server,
}: AgentTerminalPanelProps): React.ReactElement {
  const terminalRef = useRef<XtermTerminalHandle>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const finishedRef = useRef(false);
  const startTimer = useRef<number | undefined>(undefined);
  const pendingOutput = useRef("");
  const [phase, setPhase] = useState<TerminalPhase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [identity, setIdentity] = useState<TerminalIdentity | null>(null);
  const [opening, setOpening] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [fontSize, setFontSize] = useState<number>(TERMINAL_FONT_SIZE.default);
  const [size, setSize] = useState<{
    cols: number | null;
    rows: number | null;
  }>({ cols: null, rows: null });

  const unavailableReason = !server.enabled
    ? "disabled"
    : server.transportMode !== "ws" || !server.wsConnectedAt
      ? "offline"
      : !(
            server.agentCapabilities?.includes("pty-v1") ||
            server.agentCapabilities?.includes("pty-v2")
          )
        ? "unsupported"
        : null;
  const unavailable = unavailableReason
    ? unavailableMessage(unavailableReason)
    : null;

  // The server-rendered default avoids a hydration mismatch, then the stored
  // preference applies once the browser storage is available.
  useEffect(() => {
    setFontSize(readTerminalFontSize(window.localStorage));
  }, []);

  // Leaving the terminal view, or switching servers, ends the shell. A new
  // server starts from the idle state rather than showing the old session.
  useEffect(() => {
    setPhase("idle");
    setNotice(null);
    setIdentity(null);
    setOpening(false);
    setTerminalMounted(false);
    setSize({ cols: null, rows: null });
    return () => {
      finishedRef.current = true;
      if (startTimer.current !== undefined) {
        window.clearTimeout(startTimer.current);
        startTimer.current = undefined;
      }
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, "view_closed");
    };
  }, [server.id]);

  const write = (data: string) => {
    if (terminalRef.current) {
      terminalRef.current.write(data);
      return;
    }
    pendingOutput.current = (pendingOutput.current + data).slice(
      -MAX_BUFFERED_OUTPUT,
    );
  };

  const clearStartTimer = () => {
    if (startTimer.current !== undefined) {
      window.clearTimeout(startTimer.current);
      startTimer.current = undefined;
    }
  };

  // Input and resizes are sent only once the shell exists on the agent.
  const send = (type: string, payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    const sessionId = sessionRef.current;
    if (
      !sessionId ||
      !startedRef.current ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    socket.send(
      JSON.stringify({ v: 1, type, payload: { sessionId, ...payload } }),
    );
  };

  const open = async () => {
    if (unavailable || opening) {
      return;
    }
    const confirmed = await Confirm.call({
      title: m.agent_terminal_confirm_title(),
      description: m.agent_terminal_confirm_description(),
      confirmLabel: m.agent_terminal_action_connect(),
      cancelLabel: m.agent_terminal_action_cancel(),
    });
    if (!confirmed) {
      return;
    }

    setOpening(true);
    setNotice(null);
    setIdentity(null);
    setPhase("connecting");
    pendingOutput.current = "";

    const probe = await probeTerminal(server.id);
    if (probe.kind !== "ready") {
      setOpening(false);
      setPhase("error");
      setNotice(probeNotice(probe));
      return;
    }

    const sessionId = `pty-${crypto.randomUUID()}`;
    sessionRef.current = sessionId;
    startedRef.current = false;
    finishedRef.current = false;
    setSessionKey((value) => value + 1);
    setTerminalMounted(true);

    const url = new URL(
      `/api/admin/servers/${encodeURIComponent(server.id)}/pty/ws`,
      window.location.href,
    );
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("cols", "80");
    url.searchParams.set("rows", "24");

    const socket = new WebSocket(url);
    socketRef.current = socket;
    startTimer.current = window.setTimeout(() => {
      startTimer.current = undefined;
      if (startedRef.current || finishedRef.current) {
        return;
      }
      finishedRef.current = true;
      setOpening(false);
      setPhase("error");
      setNotice(exitNotice({ reason: "relay_timeout" }));
      socket.close(1011, "relay_timeout");
    }, PTY_OPEN_TIMEOUT_MS);

    socket.onopen = () => {
      terminalRef.current?.focus();
    };
    socket.onmessage = (event) => {
      const frame = parseServerFrame(String(event.data));
      if (!frame || frame.payload?.sessionId !== sessionRef.current) {
        return;
      }
      if (frame.type === "pty.started") {
        if (finishedRef.current) {
          return;
        }
        startedRef.current = true;
        clearStartTimer();
        setOpening(false);
        setPhase("connected");
        setIdentity({
          shell: frame.payload?.shell ?? "",
          user: frame.payload?.user ?? "",
        });
        // The shell began at the default size; correct it now that input is open.
        terminalRef.current?.fit();
        terminalRef.current?.focus();
        return;
      }
      if (frame.type === "pty.data" && typeof frame.payload.data === "string") {
        write(frame.payload.data);
        if (socket.bufferedAmount > MAX_BROWSER_BACKLOG) {
          finishedRef.current = true;
          setOpening(false);
          setNotice(m.agent_terminal_notice_backpressure());
          setPhase("error");
          socket.close(1011, "client_backpressure");
        }
        return;
      }
      if (frame.type === "pty.exit") {
        finishedRef.current = true;
        clearStartTimer();
        setOpening(false);
        setPhase(startedRef.current ? "closed" : "error");
        setNotice(exitNotice(frame.payload));
        socket.close(1000, "terminal_exit");
      }
    };
    socket.onerror = () => {
      clearStartTimer();
      finishedRef.current = true;
      setOpening(false);
      setPhase("error");
      setNotice(m.agent_terminal_notice_socket_error());
    };
    socket.onclose = () => {
      clearStartTimer();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setOpening(false);
      if (finishedRef.current) {
        return;
      }
      finishedRef.current = true;
      if (startedRef.current) {
        setPhase("closed");
        setNotice(m.agent_terminal_notice_disconnected());
      } else {
        setPhase("error");
        setNotice(m.agent_terminal_notice_closed_before_start());
      }
    };
  };

  const disconnect = () => {
    finishedRef.current = true;
    clearStartTimer();
    socketRef.current?.close(1000, "admin_closed");
    socketRef.current = null;
    setOpening(false);
    setPhase("closed");
    setNotice(m.agent_terminal_notice_disconnected());
  };

  const handleReady = () => {
    if (pendingOutput.current) {
      terminalRef.current?.write(pendingOutput.current);
      pendingOutput.current = "";
    }
    terminalRef.current?.fit();
    const nextSize = terminalRef.current?.getSize();
    if (nextSize) {
      setSize(nextSize);
    }
  };

  const changeFontSize = (next: number) => {
    const clamped = clampTerminalFontSize(next);
    setFontSize(clamped);
    writeTerminalFontSize(window.localStorage, clamped);
  };

  const connect = () => void open();

  // A shell that ended keeps its scrollback; only failures before a session
  // exists take over the canvas.
  const showEmptyState =
    !terminalMounted || (phase === "error" && notice !== null);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-slot="agent-terminal-panel"
    >
      <TerminalSessionBar
        fontSize={fontSize}
        host={server.address}
        identity={identity}
        onClear={() => terminalRef.current?.clear()}
        onConnect={connect}
        onDisconnect={disconnect}
        onFontSizeChange={changeFontSize}
        onRefit={() => terminalRef.current?.fit()}
        opening={opening}
        phase={phase}
        terminalMounted={terminalMounted}
        unavailable={Boolean(unavailable)}
      />

      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-terminal"
        data-slot="terminal-canvas"
      >
        {terminalMounted ? (
          <XtermTerminal
            key={sessionKey}
            ref={terminalRef}
            className="absolute inset-0"
            fontSize={fontSize}
            onReady={handleReady}
            onData={(data) => send("pty.data", { data })}
            onResize={(cols, rows) => {
              setSize({ cols, rows });
              send("pty.resize", { cols, rows });
            }}
            onSize={(cols, rows) => setSize({ cols, rows })}
            onError={(message) => {
              setPhase("error");
              setNotice(m.agent_terminal_notice_render_error({ message }));
            }}
          />
        ) : null}

        {showEmptyState ? (
          <TerminalEmptyState
            notice={notice}
            onConnect={connect}
            opening={opening}
            phase={phase}
            unavailable={unavailable}
          />
        ) : null}
      </div>

      <TerminalStatusBar
        cols={size.cols}
        notice={notice}
        phase={phase}
        rows={size.rows}
      />
    </section>
  );
}
