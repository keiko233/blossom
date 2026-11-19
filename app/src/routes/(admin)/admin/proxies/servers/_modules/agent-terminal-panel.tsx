"use client";

import { EraserIcon, SquareTerminalIcon, UnplugIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import {
  XtermTerminal,
  type XtermTerminalHandle,
} from "@/components/terminal/xterm-terminal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { PTY_OPEN_TIMEOUT_MS } from "@/lib/pty-protocol";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

export interface AgentTerminalPanelProps {
  server: ServerDTO;
}

type TerminalPhase = "idle" | "connecting" | "connected" | "closed" | "error";

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
  const [identity, setIdentity] = useState<{
    shell: string;
    user: string;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [terminalMounted, setTerminalMounted] = useState(false);

  const unavailableReason = !server.enabled
    ? "disabled"
    : server.transportMode !== "ws" || !server.wsConnectedAt
      ? "offline"
      : !server.agentCapabilities?.includes("pty-v1")
        ? "unsupported"
        : null;
  const unavailable = unavailableReason
    ? unavailableMessage(unavailableReason)
    : null;

  // Leaving the terminal view, or switching servers, ends the shell. A new
  // server starts from the idle state rather than showing the old session.
  useEffect(() => {
    setPhase("idle");
    setNotice(null);
    setIdentity(null);
    setOpening(false);
    setTerminalMounted(false);
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
  };

  const badge =
    phase === "connected" ? (
      <Badge variant="success">{m.agent_terminal_status_connected()}</Badge>
    ) : phase === "connecting" ? (
      <Badge variant="warning">{m.agent_terminal_status_connecting()}</Badge>
    ) : phase === "error" ? (
      <Badge variant="error">{m.agent_terminal_status_error()}</Badge>
    ) : phase === "closed" ? (
      <Badge variant="outline">{m.agent_terminal_status_closed()}</Badge>
    ) : (
      <Badge variant="outline">{m.agent_terminal_status_idle()}</Badge>
    );

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
      data-slot="agent-terminal-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <SquareTerminalIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium">{m.agent_terminal_title()}</h2>
            {badge}
          </div>
          <p className="text-xs text-muted-foreground">
            {m.agent_terminal_description()}
          </p>
          {phase === "connected" && identity ? (
            <p
              className="text-xs text-muted-foreground"
              data-slot="terminal-identity"
            >
              {m.agent_terminal_identity({
                user: identity.user,
                shell: identity.shell,
              })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {terminalMounted &&
          (phase === "connected" || phase === "connecting") ? (
            <Button size="sm" variant="outline" onClick={disconnect}>
              <UnplugIcon />
              {m.agent_terminal_action_disconnect()}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={Boolean(unavailable) || opening}
              loading={opening}
              onClick={() => void open()}
            >
              <SquareTerminalIcon />
              {m.agent_terminal_action_connect()}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!terminalMounted}
            onClick={() => terminalRef.current?.clear()}
          >
            <EraserIcon />
            {m.agent_terminal_action_clear()}
          </Button>
        </div>
      </div>

      {unavailable ? (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          {unavailable}
        </p>
      ) : (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
          {m.agent_terminal_opt_in_note()}
        </p>
      )}

      {notice ? (
        <p
          className="text-sm text-muted-foreground"
          data-slot="terminal-notice"
        >
          {notice}
        </p>
      ) : null}

      {terminalMounted ? (
        <XtermTerminal
          key={sessionKey}
          ref={terminalRef}
          className="h-[28rem]"
          onReady={handleReady}
          onData={(data) => send("pty.data", { data })}
          onResize={(cols, rows) => send("pty.resize", { cols, rows })}
          onError={(message) => {
            setPhase("error");
            setNotice(m.agent_terminal_notice_render_error({ message }));
          }}
        />
      ) : null}
    </section>
  );
}
