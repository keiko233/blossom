"use client";

import {
  LOG_POLICY_CAPABILITY,
  LOG_POLICY_DEFAULT_TEMPORARY_SECONDS,
  LOG_POLICY_SOURCES,
  type LogPolicyLevel,
  type LogPolicySource,
} from "@blossom/contracts/log-policy";
import { RefreshCwIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/format";
import {
  hasTemporaryLogPolicyRequest,
  logPolicyCues,
  temporarySecondsFromMinutes,
  type LogPolicyCue,
} from "@/lib/log-policy-view";
import { m } from "@/paraglide/messages";
import type { ServerLogPolicySourceView } from "@/query/log-policy";
import type { ServerDTO } from "@/query/servers";

import {
  useServerLogPolicy,
  type LogPolicyIntent,
} from "./use-server-log-policy";

const BASELINE_LEVELS = ["error", "warn", "info"] as const;
const TEMPORARY_LEVELS = ["debug", "trace"] as const;
const DEFAULT_DURATION_MINUTES = String(
  LOG_POLICY_DEFAULT_TEMPORARY_SECONDS / 60,
);

const cueVariants: Record<
  LogPolicyCue,
  "success" | "warning" | "info" | "error" | "outline"
> = {
  unsupported: "outline",
  disabled: "outline",
  offline: "outline",
  pending: "warning",
  applying: "info",
  error: "error",
  "not-reported": "outline",
  "in-sync": "success",
};

function levelLabel(level: LogPolicyLevel): string {
  switch (level) {
    case "default":
      return m.agent_logs_level_default();
    case "error":
      return m.agent_logs_level_error();
    case "warn":
      return m.agent_logs_level_warn();
    case "info":
      return m.agent_logs_level_info();
    case "debug":
      return m.agent_logs_level_debug();
    case "trace":
      return m.agent_logs_level_trace();
  }
}

function sourceLabel(source: LogPolicySource): string {
  return source === "agent"
    ? m.agent_logs_policy_source_agent()
    : m.agent_logs_policy_source_sing_box();
}

function cueLabel(cue: LogPolicyCue): string {
  switch (cue) {
    case "unsupported":
      return m.agent_logs_policy_status_unsupported();
    case "disabled":
      return m.agent_logs_policy_status_disabled();
    case "offline":
      return m.agent_logs_policy_status_offline();
    case "pending":
      return m.agent_logs_policy_status_pending();
    case "applying":
      return m.agent_logs_policy_status_applying();
    case "error":
      return m.agent_logs_policy_status_error();
    case "not-reported":
      return m.agent_logs_policy_status_not_reported();
    case "in-sync":
      return m.agent_logs_policy_status_in_sync();
  }
}

function deadlineText(view: ServerLogPolicySourceView): string {
  if (!view.desiredDeadline) {
    return m.agent_logs_policy_deadline_none();
  }
  const time = formatDateTime(view.desiredDeadline);
  return view.expired
    ? m.agent_logs_policy_deadline_expired({ time })
    : m.agent_logs_policy_deadline_value({ time });
}

function temporaryText(view: ServerLogPolicySourceView): string {
  if (!hasTemporaryLogPolicyRequest(view)) {
    return m.agent_logs_policy_temporary_none();
  }
  return levelLabel(view.desiredLevel);
}

function LogPolicySourceCard({
  view,
  capability,
  enabled,
  offline,
  busy,
  activeIntent,
  onUpdate,
  onRestore,
}: {
  view: ServerLogPolicySourceView;
  capability: boolean;
  enabled: boolean;
  offline: boolean;
  busy: boolean;
  activeIntent: LogPolicyIntent | undefined;
  onUpdate: (
    source: LogPolicySource,
    level: LogPolicyLevel,
    temporarySeconds?: number,
  ) => void;
  onRestore: (
    source: LogPolicySource,
    mode: "restore-baseline" | "restore-default",
  ) => void;
}): React.ReactElement {
  const [baselineDraft, setBaselineDraft] = useState<string | null>(
    view.desiredBaseline === "default" ? null : view.desiredBaseline,
  );
  const [temporaryDraft, setTemporaryDraft] = useState<string | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(
    DEFAULT_DURATION_MINUTES,
  );

  useEffect(() => {
    setBaselineDraft(
      view.desiredBaseline === "default" ? null : view.desiredBaseline,
    );
  }, [view.desiredBaseline]);

  const cues = logPolicyCues({ view, capability, enabled, offline });
  const canEdit = capability && enabled;
  const cardId = `agent-logs-policy-${view.source}`;
  const canRestoreNow = hasTemporaryLogPolicyRequest(view);
  const temporarySeconds = temporarySecondsFromMinutes(durationMinutes);
  const durationInvalid = temporaryDraft !== null && temporarySeconds === null;
  const baselineUnchanged =
    baselineDraft === view.desiredBaseline && !canRestoreNow;
  const activeForSource = busy && activeIntent?.source === view.source;

  return (
    <article
      aria-labelledby={`${cardId}-title`}
      data-slot="server-log-policy-source"
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-muted/20 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${cardId}-title`} className="font-medium">
            {sourceLabel(view.source)}
          </h3>
          <div
            role="status"
            aria-live="polite"
            className="flex flex-wrap gap-1.5"
          >
            {cues.map((cue) => (
              <Badge key={cue} variant={cueVariants[cue]}>
                {cueLabel(cue)}
              </Badge>
            ))}
          </div>
        </div>
        {activeForSource ? (
          <Spinner aria-label={m.agent_logs_policy_saving()} />
        ) : null}
      </div>

      {!capability ? (
        <p className="text-xs text-muted-foreground">
          {m.agent_logs_policy_unsupported_description()}
        </p>
      ) : !enabled ? (
        <p className="text-xs text-muted-foreground">
          {m.agent_logs_policy_disabled_description()}
        </p>
      ) : offline ? (
        <p className="text-xs text-muted-foreground">
          {m.agent_logs_policy_offline_description()}
        </p>
      ) : null}

      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs text-muted-foreground">
            {m.agent_logs_policy_configured_baseline()}
          </dt>
          <dd className="font-medium break-words">
            {levelLabel(view.desiredBaseline)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs text-muted-foreground">
            {m.agent_logs_policy_temporary_override()}
          </dt>
          <dd className="font-medium break-words">{temporaryText(view)}</dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs text-muted-foreground">
            {m.agent_logs_policy_target()}
          </dt>
          <dd className="font-medium break-words">
            {levelLabel(view.targetLevel)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs text-muted-foreground">
            {m.agent_logs_policy_effective()}
          </dt>
          <dd className="font-medium break-words">
            {view.effectiveLevel
              ? levelLabel(view.effectiveLevel)
              : m.agent_logs_policy_effective_unknown()}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs text-muted-foreground">
            {m.agent_logs_policy_deadline()}
          </dt>
          <dd className="break-words">{deadlineText(view)}</dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-xs text-muted-foreground">
            {m.agent_logs_policy_last_ack()}
          </dt>
          <dd className="break-words">
            {view.effectiveAt
              ? formatDateTime(view.effectiveAt)
              : m.agent_logs_policy_last_ack_never()}
          </dd>
        </div>
      </dl>

      {view.effectiveError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/24 bg-destructive/8 p-2 text-sm text-destructive-foreground"
        >
          {m.agent_logs_policy_apply_error({
            message: view.effectiveError,
          })}
        </p>
      ) : null}

      {view.source === "sing-box" && canEdit ? (
        <p
          role="note"
          className="rounded-md border border-warning/24 bg-warning/8 p-2 text-xs text-warning-foreground"
        >
          {m.agent_logs_policy_sing_box_warning()}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <span id={`${cardId}-baseline-label`} className="text-xs font-medium">
          {m.agent_logs_policy_set_baseline()}
        </span>
        <div className="flex flex-wrap items-end gap-2">
          <Select
            items={BASELINE_LEVELS.map((level) => ({
              label: levelLabel(level),
              value: level,
            }))}
            value={baselineDraft}
            onValueChange={setBaselineDraft}
            disabled={!canEdit}
          >
            <SelectTrigger
              size="sm"
              className="w-40"
              aria-labelledby={`${cardId}-baseline-label`}
            >
              <SelectValue placeholder={m.agent_logs_policy_choose_level()} />
            </SelectTrigger>
            <SelectPopup>
              {BASELINE_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {levelLabel(level)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !canEdit || busy || baselineDraft === null || baselineUnchanged
            }
            aria-label={m.agent_logs_policy_apply_baseline_for({
              source: sourceLabel(view.source),
            })}
            onClick={() => {
              if (baselineDraft) {
                onUpdate(view.source, baselineDraft as LogPolicyLevel);
              }
            }}
          >
            {m.agent_logs_policy_apply_baseline()}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span id={`${cardId}-temporary-label`} className="text-xs font-medium">
          {m.agent_logs_policy_set_temporary()}
        </span>
        <div className="flex flex-wrap items-end gap-2">
          <Select
            items={TEMPORARY_LEVELS.map((level) => ({
              label: levelLabel(level),
              value: level,
            }))}
            value={temporaryDraft}
            onValueChange={setTemporaryDraft}
            disabled={!canEdit}
          >
            <SelectTrigger
              size="sm"
              className="w-32"
              aria-labelledby={`${cardId}-temporary-label`}
            >
              <SelectValue placeholder={m.agent_logs_policy_choose_level()} />
            </SelectTrigger>
            <SelectPopup>
              {TEMPORARY_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {levelLabel(level)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <label
            htmlFor={`${cardId}-duration`}
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {m.agent_logs_policy_duration_minutes()}
            <Input
              id={`${cardId}-duration`}
              type="number"
              inputMode="decimal"
              min={0.5}
              max={60}
              step={0.5}
              value={durationMinutes}
              disabled={!canEdit}
              aria-invalid={durationInvalid}
              aria-describedby={`${cardId}-duration-hint`}
              onChange={(event) => setDurationMinutes(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !canEdit ||
              busy ||
              temporaryDraft === null ||
              temporarySeconds === null
            }
            aria-label={m.agent_logs_policy_apply_temporary_for({
              source: sourceLabel(view.source),
            })}
            onClick={() => {
              if (temporaryDraft && temporarySeconds !== null) {
                onUpdate(
                  view.source,
                  temporaryDraft as LogPolicyLevel,
                  temporarySeconds,
                );
              }
            }}
          >
            {m.agent_logs_policy_apply_temporary()}
          </Button>
        </div>
        <p
          id={`${cardId}-duration-hint`}
          className={
            durationInvalid
              ? "text-xs text-destructive-foreground"
              : "text-xs text-muted-foreground"
          }
        >
          {durationInvalid
            ? m.agent_logs_policy_duration_invalid()
            : m.agent_logs_policy_duration_hint()}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!canEdit || busy || !canRestoreNow}
          aria-label={m.agent_logs_policy_restore_now_for({
            source: sourceLabel(view.source),
          })}
          onClick={() => onRestore(view.source, "restore-baseline")}
        >
          {m.agent_logs_policy_restore_now()}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            !canEdit ||
            busy ||
            (view.desiredBaseline === "default" && !canRestoreNow)
          }
          aria-label={m.agent_logs_policy_restore_default_for({
            source: sourceLabel(view.source),
          })}
          onClick={() => onRestore(view.source, "restore-default")}
        >
          {m.agent_logs_policy_restore_default()}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {m.agent_logs_policy_restore_hint()}
      </p>
    </article>
  );
}

/**
 * Per-source log level controls. Reads through the audited admin function and
 * writes only through its compare-and-swap update/reset functions. A conflict
 * reloads the returned policy and requires an explicit retry with that newer
 * revision; status refresh is a read and never touches the log subscription.
 */
export function ServerLogPolicyPanel({
  server,
}: {
  server: ServerDTO;
}): React.ReactElement {
  const capability =
    server.agentCapabilities?.includes(LOG_POLICY_CAPABILITY) ?? false;
  const offline =
    server.transportMode !== "ws" || server.wsConnectedAt === null;
  const controller = useServerLogPolicy(server.id);
  const policy = controller.policy;

  return (
    <section
      aria-labelledby="agent-logs-policy-title"
      data-slot="server-log-policy-panel"
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id="agent-logs-policy-title" className="font-medium">
            {m.agent_logs_policy_title()}
          </h3>
          <p className="text-xs text-muted-foreground">
            {m.agent_logs_policy_description()}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          loading={controller.refreshing}
          onClick={() => void controller.refresh()}
        >
          <RefreshCwIcon />
          {m.agent_logs_policy_refresh()}
        </Button>
      </div>

      {controller.conflict ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-warning/24 bg-warning/8 p-3"
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-warning-foreground">
              {m.agent_logs_policy_conflict_title()}
            </p>
            <p className="text-sm text-warning-foreground">
              {m.agent_logs_policy_conflict_description()}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              loading={controller.busy}
              disabled={controller.refreshing}
              onClick={controller.retryConflict}
            >
              {m.agent_logs_policy_conflict_retry()}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={controller.busy}
              onClick={controller.dismissConflict}
            >
              {m.agent_logs_policy_conflict_dismiss()}
            </Button>
          </div>
        </div>
      ) : null}

      {controller.loading ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground"
        >
          <Spinner />
          {m.agent_logs_policy_loading()}
        </div>
      ) : controller.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/24 bg-destructive/8 p-3 text-sm text-destructive-foreground"
        >
          <span>{m.agent_logs_policy_load_error()}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void controller.refresh()}
          >
            {m.agent_logs_policy_load_retry()}
          </Button>
        </div>
      ) : policy ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {LOG_POLICY_SOURCES.map((source) => (
            <LogPolicySourceCard
              key={source}
              view={policy.sources[source]}
              capability={capability}
              enabled={server.enabled}
              offline={offline}
              busy={controller.busy}
              activeIntent={controller.activeIntent}
              onUpdate={controller.update}
              onRestore={controller.restore}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
