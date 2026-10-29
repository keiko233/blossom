import { targetTypeLabel } from "@/components/audit-labels";
import { AuditStatusBadge } from "@/components/audit-status-badge";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { AdminAuditEntry } from "@/query/admin-audit";

export interface AuditActivityListProps {
  entries: readonly AdminAuditEntry[];
}

/** Compact feed of admin audit entries, newest first (dashboard, user page). */
export function AuditActivityList({ entries }: AuditActivityListProps) {
  return (
    <ul className="flex flex-col divide-y">
      {entries.map((entry) => (
        <li
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5"
          key={entry.id}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm font-medium">
                {entry.action}
              </span>
              {entry.status === "error" ? (
                <AuditStatusBadge status={entry.status} />
              ) : null}
            </div>
            <span className="truncate text-xs text-muted-foreground">
              {entry.targetType
                ? `${targetTypeLabel(entry.targetType)}${entry.targetId ? ` · ${entry.targetId}` : ""} · `
                : ""}
              {m.admin_audit_activity_by({
                actor: entry.actorEmail ?? m.admin_audit_actor_deleted(),
              })}
            </span>
          </div>
          <time
            className="text-xs text-muted-foreground"
            dateTime={new Date(entry.createdAt).toISOString()}
          >
            {formatDateTime(entry.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}
