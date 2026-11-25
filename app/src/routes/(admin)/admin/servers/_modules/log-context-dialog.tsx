"use client";

import type { AgentWsV2LogRecord } from "@blossom/contracts/agent-ws-v2-logs";
import type React from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatLogTime, padLevel } from "@/lib/log-view-format";
import { m } from "@/paraglide/messages";

import { logErrorMessage } from "./log-error-message";
import { LogLineText } from "./log-line-text";
import type { LogContextState } from "./use-server-logs";

export interface LogContextDialogProps {
  state: LogContextState | null;
  query: string;
  onClose(): void;
}

interface ContextLineProps {
  record: AgentWsV2LogRecord;
  query: string;
  tone: "before" | "target" | "after";
}

function ContextLine({
  record,
  query,
  tone,
}: ContextLineProps): React.ReactElement {
  const toneClass =
    tone === "target"
      ? "border-primary bg-primary/8"
      : "border-transparent bg-muted/20";

  return (
    <div
      className={`flex gap-2 rounded-md border-s-2 px-2 py-1 font-mono text-xs ${toneClass}`}
      data-slot="log-context-line"
      data-tone={tone}
    >
      <span className="shrink-0 text-muted-foreground">
        {formatLogTime(record.time)}
      </span>
      <span className="shrink-0 font-semibold">{padLevel(record.level)}</span>
      <span className="shrink-0 text-muted-foreground">{record.source}</span>
      <span className="min-w-0 break-words whitespace-pre-wrap">
        <LogLineText text={record.text} query={query} />
      </span>
    </div>
  );
}

/** Bounded context around one retained record; text stays in React nodes. */
export function LogContextDialog({
  state,
  query,
  onClose,
}: LogContextDialogProps): React.ReactElement {
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.agent_logs_context_title()}</DialogTitle>
          <DialogDescription>
            {m.agent_logs_context_description()}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] px-6 pb-6" scrollFade>
          {state?.status === "loading" ? (
            <div
              role="status"
              aria-busy="true"
              className="flex flex-col gap-1 py-2"
            >
              <span className="sr-only">{m.admin_ui_loading()}</span>
              {Array.from({ length: 8 }, (_, row) => (
                <div key={row} className="flex items-center gap-2 px-2 py-1">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="h-2.5 w-10" />
                  <Skeleton className="h-2.5 flex-1" />
                </div>
              ))}
            </div>
          ) : state?.status === "error" ? (
            <p className="py-6 text-sm text-destructive">
              {logErrorMessage(state.error)}
            </p>
          ) : state?.status === "ready" ? (
            <div className="flex min-w-0 flex-col gap-1">
              {state.before.map((record) => (
                <ContextLine
                  key={`before-${record.seq}`}
                  record={record}
                  query={query}
                  tone="before"
                />
              ))}
              <ContextLine record={state.target} query={query} tone="target" />
              {state.after.map((record) => (
                <ContextLine
                  key={`after-${record.seq}`}
                  record={record}
                  query={query}
                  tone="after"
                />
              ))}
            </div>
          ) : null}
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
}
