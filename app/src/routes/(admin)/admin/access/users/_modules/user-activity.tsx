import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type React from "react";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { AuditActivityList } from "@/components/audit-activity-list";
import { Button } from "@/components/ui/button";
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
    <section className="flex flex-col gap-3">
      <SectionHeader>
        <SectionTitle>{m.admin_audit_user_activity_title()}</SectionTitle>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              search={{ targetType: "user", targetId: userId }}
              to="/admin/operations/audit"
            />
          }
        >
          {m.admin_audit_user_activity_view_all()}
        </Button>
      </SectionHeader>
      {isPending ? (
        <TableSkeleton columns={3} rows={5} />
      ) : data && data.rows.length > 0 ? (
        <div>
          <AuditActivityList entries={data.rows} />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {m.admin_audit_user_activity_empty()}
        </div>
      )}
    </section>
  );
}
