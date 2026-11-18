"use client";

import { EraserIcon, SquareTerminalIcon, UnplugIcon } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";

import {
  XtermTerminal,
  type XtermTerminalHandle,
} from "@/components/terminal/xterm-terminal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
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
  };
}

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

/**
 * The browser half of the agent terminal. A session is created only after an
 * explicit admin confirmation; the control plane authenticates the WebSocket
 * upgrade and relays it to the already-enrolled agent.
 */
export function AgentTerminalPanel({
  server,
}: AgentTerminalPanelProps): React.ReactElement {
  const terminalRef = useRef<XtermTerminalHandle>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pendingOutput = useRef("");
  const [phase, setPhase] = useState<TerminalPhase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [terminalMounted, setTerminalMounted] = useState(false);

  const unavailable = !server.enabled
    ? m.agent_terminal_unavailable_disabled()
    : server.transportMode !== "ws" || !server.wsConnectedAt
      ? m.agent_terminal_unavailable_offline()
      : !server.agentCapabilities?.includes("pty-v1")
        ? m.agent_terminal_unavailable_unsupported()
        : null;

  const write = (data: string) => {
    if (terminalRef.current) {
      terminalRef.current.write(data);
      return;
    }
    pendingOutput.current = (pendingOutput.current + data).slice(
      -MAX_BUFFERED_OUTPUT,
    );
  };

  const send = (type: string, payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    const sessionId = sessionRef.current;
    if (!sessionId || socket?.readyState !== WebSocket.OPEN) {
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
    setPhase("connecting");
    pendingOutput.current = "";
    const sessionId = `pty-${crypto.randomUUID()}`;
    sessionRef.current = sessionId;
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
    socket.onopen = () => {
      setOpening(false);
      setPhase("connected");
      terminalRef.current?.focus();
    };
    socket.onmessage = (event) => {
      const frame = parseServerFrame(String(event.data));
      if (!frame || frame.payload?.sessionId !== sessionRef.current) {
        return;
      }
      if (frame.type === "pty.data" && typeof frame.payload.data === "string") {
        write(frame.payload.data);
        if (socket.bufferedAmount > MAX_BROWSER_BACKLOG) {
          setNotice(m.agent_terminal_notice_backpressure());
          setPhase("error");
          socket.close(1011, "client_backpressure");
        }
        return;
      }
      if (frame.type === "pty.exit") {
        setPhase("closed");
        setNotice(
          m.agent_terminal_exit_reason({
            reason: frame.payload.reason ?? "closed",
          }),
        );
        socket.close(1000, "terminal_exit");
      }
    };
    socket.onerror = () => {
      setOpening(false);
      setPhase("error");
      setNotice(m.agent_terminal_notice_socket_error());
    };
    socket.onclose = () => {
      setOpening(false);
      setPhase((current) => (current === "error" ? current : "closed"));
      socketRef.current = null;
    };
  };

  const disconnect = () => {
    socketRef.current?.close(1000, "admin_closed");
    socketRef.current = null;
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
        </div>
        <div className="flex flex-wrap gap-2">
          {terminalMounted && phase === "connected" ? (
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
