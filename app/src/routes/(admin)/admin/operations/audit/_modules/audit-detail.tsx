import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { AdminAuditEntry, McpAuditEntry } from "@/query/admin-audit";

function JsonBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-72 overflow-auto rounded-md border bg-muted/32 p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

function isEmptyJson(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "object" && Object.keys(value).length === 0)
  );
}

export interface AdminAuditDetailProps {
  entry: AdminAuditEntry;
  /** Narrows the list to every entry touching this entry's target. */
  onFilterTarget: (targetType: string, targetId: string) => void;
}

/** Expanded row of an admin audit entry: the redacted input, error and context. */
export function AdminAuditDetail({
  entry,
  onFilterTarget,
}: AdminAuditDetailProps) {
  return (
    <div className="flex flex-col gap-4 p-1">
      {entry.error ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {m.admin_audit_detail_error()}
          </span>
          <p className="rounded-md border border-destructive/32 bg-destructive/8 p-3 font-mono text-xs break-all whitespace-pre-wrap text-destructive-foreground">
            {entry.error}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {isEmptyJson(entry.input) ? (
          <p className="text-sm text-muted-foreground">
            {m.admin_audit_detail_no_input()}
          </p>
        ) : (
          <JsonBlock
            label={m.admin_audit_detail_input()}
            value={JSON.stringify(entry.input, null, 2)}
          />
        )}
        {isEmptyJson(entry.metadata) ? null : (
          <JsonBlock
            label={m.admin_audit_detail_metadata()}
            value={JSON.stringify(entry.metadata, null, 2)}
          />
        )}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {entry.actorUserId ? (
          <Fact label={m.admin_audit_detail_actor_id()}>
            <span className="font-mono text-xs">{entry.actorUserId}</span>
          </Fact>
        ) : null}
        {entry.ip ? (
          <Fact label={m.admin_audit_detail_ip()}>{entry.ip}</Fact>
        ) : null}
        {entry.userAgent ? (
          <Fact label={m.admin_audit_detail_user_agent()}>
            {entry.userAgent}
          </Fact>
        ) : null}
        {entry.durationMs === null ? null : (
          <Fact label={m.admin_audit_detail_duration()}>
            {m.admin_audit_duration_ms({ ms: entry.durationMs })}
          </Fact>
        )}
        {entry.impersonatedBy ? (
          <Fact label={m.admin_audit_detail_impersonated_by()}>
            <span className="font-mono text-xs">{entry.impersonatedBy}</span>
          </Fact>
        ) : null}
      </dl>

      {entry.targetType && entry.targetId ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onFilterTarget(entry.targetType!, entry.targetId!)}
          >
            {m.admin_audit_detail_target_link()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Pretty-prints a stored JSON string; falls back to the raw text. */
function prettyJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Expanded row of an MCP tool call: its redacted input and error. */
export function McpAuditDetail({ entry }: { entry: McpAuditEntry }) {
  return (
    <div className="flex flex-col gap-4 p-1">
      {entry.redactedError ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {m.admin_audit_detail_error()}
          </span>
          <p className="rounded-md border border-destructive/32 bg-destructive/8 p-3 font-mono text-xs break-all whitespace-pre-wrap text-destructive-foreground">
            {entry.redactedError}
          </p>
        </div>
      ) : null}
      {entry.redactedInput ? (
        <JsonBlock
          label={m.admin_audit_detail_input()}
          value={prettyJsonText(entry.redactedInput)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {m.admin_audit_detail_no_input()}
        </p>
      )}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {entry.actorUserId ? (
          <Fact label={m.admin_audit_detail_actor_id()}>
            <span className="font-mono text-xs">{entry.actorUserId}</span>
          </Fact>
        ) : null}
        {entry.durationMs === null ? null : (
          <Fact label={m.admin_audit_detail_duration()}>
            {m.admin_audit_duration_ms({ ms: entry.durationMs })}
          </Fact>
        )}
      </dl>
    </div>
  );
}
