"use client";

import type React from "react";
import { useEffect, useState } from "react";

import { WorkbenchStatusBar } from "@/components/app-shell/workspace";
import { StatusDot } from "@/components/ui/status-dot";
import {
  formatTerminalSize,
  terminalPhaseTone,
  terminalTransportLabel,
  type TerminalPhase,
} from "@/lib/terminal-view";

export interface TerminalStatusBarProps {
  cols: number | null;
  notice: string | null;
  phase: TerminalPhase;
  rows: number | null;
}

export function TerminalStatusBar({
  cols,
  notice,
  phase,
  rows,
}: TerminalStatusBarProps): React.ReactElement {
  const [transport, setTransport] = useState("ws · pty");

  useEffect(() => {
    setTransport(terminalTransportLabel(window.location.protocol));
  }, []);

  return (
    <WorkbenchStatusBar
      className="overflow-hidden"
      data-slot="terminal-status-bar"
    >
      <span className="shrink-0">{transport}</span>
      <span className="shrink-0 tabular-nums">
        {formatTerminalSize(cols, rows)}
      </span>
      {notice ? (
        <span
          className="ms-auto flex min-w-0 items-center gap-1.5 truncate"
          role={phase === "error" ? "alert" : "status"}
          title={notice}
        >
          <StatusDot tone={terminalPhaseTone(phase)} />
          <span className="truncate">{notice}</span>
        </span>
      ) : null}
    </WorkbenchStatusBar>
  );
}
