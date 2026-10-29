import { auditStatusLabel } from "@/components/audit-labels";
import { Badge } from "@/components/ui/badge";

/** Outcome of an audited action: success, error or (MCP only) timeout. */
export function AuditStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "success"
          ? "success"
          : status === "timeout"
            ? "warning"
            : "error"
      }
    >
      {auditStatusLabel(status)}
    </Badge>
  );
}
