import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type React from "react";

import { AuditActivityList } from "@/components/audit-activity-list";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/paraglide/messages";
import { ADMIN_AUDIT_QUERY_KEY, listAdminAudit } from "@/query/admin-audit";

export interface UserActivityProps {
  userId: string;
}

const ACTIVITY_LIMIT = 5;

/** The latest admin actions taken on one user, with a link to the full trail. */
export function UserActivity({
  userId,
}: UserActivityProps): React.ReactElement {
  const { data, isPending } = useQuery({
    queryKey: [...ADMIN_AUDIT_QUERY_KEY, "user", userId],
    queryFn: () =>
      listAdminAudit({
        data: {
          targetType: "user",
          targetId: userId,
          page: 1,
          pageSize: ACTIVITY_LIMIT,
        },
      }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">
          {m.admin_audit_user_activity_title()}
        </h2>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              search={{ targetType: "user", targetId: userId }}
              to="/admin/audit"
            />
          }
        >
          {m.admin_audit_user_activity_view_all()}
        </Button>
      </div>
      {isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : data && data.rows.length > 0 ? (
        <div className="rounded-xl border bg-card px-4 shadow-xs">
          <AuditActivityList entries={data.rows} />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {m.admin_audit_user_activity_empty()}
        </div>
      )}
    </div>
  );
}
