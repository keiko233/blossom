"use client";

import type React from "react";

import { WorkbenchStatusBar } from "@/components/app-shell/workspace";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { logPhaseTone } from "@/lib/admin-logs-view";
import { m } from "@/paraglide/messages";

import { logErrorMessage } from "./log-error-message";
import type { LogConnectionPhase } from "./use-server-logs";

export interface LogsStatusBarProps {
  phase: LogConnectionPhase;
  tailError: string | null;
  lineCount: number;
  trimmed: number;
  selectedCount: number;
}

function phaseLabel(phase: LogConnectionPhase): string {
  switch (phase) {
    case "live":
      return m.agent_logs_status_live();
    case "paused":
      return m.agent_logs_status_paused();
    case "connecting":
      return m.agent_logs_status_connecting();
    case "reconnecting":
      return m.agent_logs_status_reconnecting();
    case "unauthorized":
      return m.agent_logs_status_unauthorized();
    case "unavailable":
      return m.agent_logs_status_unavailable();
    case "unsupported":
      return m.agent_logs_status_unsupported();
    case "error":
      return m.agent_logs_status_error();
    case "idle":
      return m.agent_logs_status_idle();
  }
}

export function LogsStatusBar({
  phase,
  tailError,
  lineCount,
  trimmed,
  selectedCount,
}: LogsStatusBarProps): React.ReactElement {
  const tone = logPhaseTone(phase);

  return (
    <WorkbenchStatusBar data-slot="logs-status-bar">
      <span
        role="status"
        className="inline-flex shrink-0 items-center gap-1.5 font-sans text-xs text-foreground"
      >
        <StatusDot tone={tone} pulse={phase === "connecting"} />
        {phaseLabel(phase)}
      </span>

      <span className="shrink-0 tabular-nums">
        {m.agent_logs_status_bar_lines({ count: lineCount })}
      </span>

      {trimmed > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="shrink-0 cursor-default tabular-nums" />}
          >
            {m.agent_logs_status_bar_trimmed({ count: trimmed })}
          </TooltipTrigger>
          <TooltipPopup>{m.agent_logs_status_bar_trimmed_hint()}</TooltipPopup>
        </Tooltip>
      ) : null}

      {selectedCount > 0 ? (
        <span className="shrink-0 tabular-nums">
          {m.agent_logs_status_bar_selected({ count: selectedCount })}
        </span>
      ) : null}

      {tailError ? (
        <span
          role="alert"
          className="min-w-0 truncate text-destructive-foreground"
        >
          {logErrorMessage(tailError)}
        </span>
      ) : phase === "reconnecting" ? (
        <span className="min-w-0 truncate text-warning-foreground">
          {m.agent_logs_reconnecting_note()}
        </span>
      ) : null}

      <KbdGroup
        aria-label={m.agent_logs_status_bar_shortcuts_label()}
        className="ms-auto hidden shrink-0 items-center gap-1.5 xl:inline-flex"
      >
        <span className="inline-flex items-center gap-1">
          <Kbd>↑↓</Kbd>
          {m.agent_logs_status_bar_move()}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Space</Kbd>
          {m.agent_logs_status_bar_select()}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd>
          {m.agent_logs_status_bar_context()}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>F</Kbd>
          {m.agent_logs_status_bar_follow()}
        </span>
      </KbdGroup>
    </WorkbenchStatusBar>
  );
}
