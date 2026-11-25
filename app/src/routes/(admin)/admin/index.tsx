import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2Icon, RefreshCwIcon, ScrollTextIcon } from "lucide-react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
  SectionActions,
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import {
  StatStripSkeleton,
  TableSkeleton,
} from "@/components/app-shell/skeletons";
import { StatStrip, StatStripItem } from "@/components/app-shell/stat-strip";
import { AuditActivityList } from "@/components/audit-activity-list";
import { SubscriptionQuotaUsage } from "@/components/subscriptions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  OVERVIEW_LIST_LIMIT,
  type ServerAttentionItem,
} from "@/lib/admin-overview";
import { formatBytes, formatDate } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { ADMIN_AUDIT_QUERY_KEY, listAdminAudit } from "@/query/admin-audit";
import {
  ADMIN_OVERVIEW_QUERY_KEY,
  getAdminOverview,
  type OverviewSubscriptionItem,
} from "@/query/admin-overview";

export const Route = createFileRoute("/(admin)/admin/")({
  component: RouteComponent,
});

const RECENT_ACTIVITY_LIMIT = 8;
const dashboardGridClassName =
  "grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] 3xl:grid-cols-[minmax(0,1fr)_28rem]";

function RouteComponent() {
  const { data, isFetching, isPending, error, refetch } = useQuery({
    queryKey: ADMIN_OVERVIEW_QUERY_KEY,
    queryFn: () => getAdminOverview(),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_dashboard()}</PageHeaderTitle>
        <PageHeaderActions>
          <Button
            loading={isFetching && !isPending}
            size="sm"
            variant="ghost"
            onClick={() => void refetch()}
          >
            <RefreshCwIcon />
            {m.admin_page_dashboard_refresh()}
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {isPending ? (
        <DashboardSkeleton />
      ) : error || !data ? (
        <PageContent>
          <Alert variant="error">
            <AlertTitle>{m.admin_overview_error_title()}</AlertTitle>
            <AlertDescription>
              {m.admin_overview_error_description()}
            </AlertDescription>
          </Alert>
          <div>
            <Button loading={isFetching} onClick={() => void refetch()}>
              {m.admin_overview_error_retry()}
            </Button>
          </div>
        </PageContent>
      ) : (
        <DashboardContent data={data} />
      )}
    </>
  );
}

function DashboardContent({
  data,
}: {
  data: Awaited<ReturnType<typeof getAdminOverview>>;
}) {
  const {
    users,
    subscriptions,
    servers,
    nodes,
    traffic,
    attentionServers,
    expiringSubscriptions,
    nearQuotaSubscriptions,
  } = data;

  return (
    <PageContent>
      <StatStrip columns={5}>
        <StatStripItem
          label={m.admin_overview_stat_users()}
          value={users.total}
          detail={
            users.banned > 0
              ? m.admin_overview_stat_users_banned({ count: users.banned })
              : undefined
          }
        />
        <StatStripItem
          label={m.admin_overview_stat_subscriptions()}
          value={subscriptions.active}
          detail={m.admin_overview_stat_subscriptions_total({
            count: subscriptions.total,
          })}
        />
        <StatStripItem
          href="/admin/servers"
          label={m.admin_overview_stat_servers()}
          value={`${servers.online} / ${servers.total}`}
          detail={
            servers.attention > 0
              ? m.admin_overview_stat_servers_attention({
                  count: servers.attention,
                })
              : m.admin_overview_stat_servers_total({
                  count: servers.total,
                })
          }
          tone={servers.attention > 0 ? "warning" : undefined}
        />
        <StatStripItem
          label={m.admin_overview_stat_nodes()}
          value={nodes.enabled}
          detail={m.admin_overview_stat_nodes_total({
            count: nodes.total,
          })}
        />
        <StatStripItem
          label={m.admin_overview_stat_traffic()}
          value={formatBytes(traffic.last24hBytes)}
          detail={m.admin_overview_stat_traffic_30d({
            bytes: formatBytes(traffic.last30dBytes),
          })}
        />
      </StatStrip>

      <div className={dashboardGridClassName}>
        <div className="flex min-w-0 flex-col gap-6">
          <ServersAttentionSection
            hasServers={servers.total > 0}
            items={attentionServers}
            total={servers.attention}
          />
          <div className="grid gap-6 2xl:grid-cols-2">
            <SubscriptionSection
              title={m.admin_overview_expiring_title()}
              emptyLabel={m.admin_overview_expiring_empty()}
              items={expiringSubscriptions}
              total={subscriptions.expiringSoon}
            />
            <SubscriptionSection
              title={m.admin_overview_quota_title()}
              emptyLabel={m.admin_overview_quota_empty()}
              items={nearQuotaSubscriptions}
              total={subscriptions.nearQuota}
            />
          </div>
        </div>

        <RecentActivityPanel />
      </div>
    </PageContent>
  );
}

function DashboardSkeleton() {
  return (
    <PageContent>
      <StatStripSkeleton items={5} />
      <div className={dashboardGridClassName}>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <TableSkeleton columns={4} rows={5} />
          </div>
          <div className="grid gap-6 2xl:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <TableSkeleton columns={3} rows={4} />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <TableSkeleton columns={3} rows={4} />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <SidebarActivitySkeleton />
        </div>
      </div>
    </PageContent>
  );
}

function SidebarActivitySkeleton() {
  return (
    <div className="flex flex-col divide-y" aria-busy="true">
      {Array.from({ length: 8 }, (_, row) => (
        <div key={row} className="flex flex-col gap-2 py-2.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

function ServersAttentionSection({
  hasServers,
  items,
  total,
}: {
  hasServers: boolean;
  items: ServerAttentionItem[];
  total: number;
}) {
  return (
    <section className="flex min-w-0 flex-col">
      <SectionHeader className="border-b pb-2">
        <SectionTitle>{m.admin_overview_servers_title()}</SectionTitle>
        <SectionActions>
          <Button
            size="sm"
            variant="ghost"
            render={<Link to="/admin/servers" />}
          >
            {m.admin_overview_servers_view_all()}
          </Button>
        </SectionActions>
      </SectionHeader>

      {items.length === 0 ? (
        <div className="border-b py-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {hasServers ? <CheckCircle2Icon /> : null}
              </EmptyMedia>
              <EmptyTitle>
                {hasServers
                  ? m.admin_overview_servers_empty_title()
                  : m.admin_overview_servers_none_title()}
              </EmptyTitle>
              <EmptyDescription>
                {hasServers
                  ? m.admin_overview_servers_empty_description()
                  : m.admin_overview_servers_none_description()}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          <Table variant="pane">
            <TableHeader className="top-(--page-header-h)!">
              <TableRow>
                <TableHead>{m.admin_page_dashboard_col_server()}</TableHead>
                <TableHead>{m.admin_page_dashboard_col_status()}</TableHead>
                <TableHead>{m.admin_page_dashboard_col_last_error()}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">
                    {m.admin_page_dashboard_open()}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      className="font-medium hover:underline"
                      params={{ serverId: item.id }}
                      to="/admin/servers/$serverId/overview"
                    >
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ServerHealth item={item} />
                  </TableCell>
                  <TableCell className="max-w-72">
                    {item.lastErrorMessage ? (
                      <span
                        className="block truncate text-xs text-destructive"
                        title={item.lastErrorMessage}
                      >
                        {item.lastErrorMessage}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button
                      aria-label={m.admin_page_dashboard_open()}
                      size="icon-xs"
                      variant="ghost"
                      render={
                        <Link
                          params={{ serverId: item.id }}
                          to="/admin/servers/$serverId/overview"
                        />
                      }
                    >
                      <span aria-hidden="true">→</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TruncationNote shown={items.length} total={total} />
        </>
      )}
    </section>
  );
}

function ServerHealth({ item }: { item: ServerAttentionItem }) {
  const label = {
    agent_offline: m.admin_proxies_servers_status_offline(),
    runtime_error: m.admin_proxies_servers_status_runtime_error(),
    config_error: m.admin_proxies_servers_status_config_error(),
    degraded: m.admin_proxies_servers_status_degraded(),
    online: m.admin_proxies_servers_status_online(),
    unknown: m.admin_proxies_servers_status_unknown(),
    disabled: m.admin_proxies_servers_status_disabled(),
  }[item.health];
  const tone =
    item.health === "online"
      ? "success"
      : item.health === "degraded" || item.health === "unknown"
        ? "warning"
        : item.health === "disabled"
          ? "muted"
          : "danger";

  return (
    <div className="flex items-center gap-2">
      <StatusDot tone={tone} />
      <span className="text-sm">{label}</span>
      {item.pendingConfigChanges > 0 ? (
        <Badge variant="warning">
          {m.admin_overview_servers_pending({
            count: item.pendingConfigChanges,
          })}
        </Badge>
      ) : null}
    </div>
  );
}

function SubscriptionSection({
  title,
  emptyLabel,
  items,
  total,
}: {
  title: string;
  emptyLabel: string;
  items: OverviewSubscriptionItem[];
  total: number;
}) {
  return (
    <section className="flex min-w-0 flex-col">
      <SectionHeader className="border-b pb-2">
        <SectionTitle>{title}</SectionTitle>
      </SectionHeader>

      {items.length === 0 ? (
        <div className="border-b py-8">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{emptyLabel}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          <Table variant="pane">
            <TableHeader className="top-(--page-header-h)!">
              <TableRow>
                <TableHead>{m.admin_page_dashboard_col_user()}</TableHead>
                <TableHead>{m.admin_page_dashboard_col_plan()}</TableHead>
                <TableHead>{m.admin_page_dashboard_col_quota()}</TableHead>
                <TableHead>{m.admin_page_dashboard_col_expires()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      className="flex min-w-0 flex-col hover:underline"
                      params={{ userId: item.userId }}
                      to="/admin/access/users/$userId"
                    >
                      <span className="truncate font-medium">
                        {item.userName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {item.userEmail}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>{item.planName}</TableCell>
                  <TableCell>
                    <SubscriptionQuotaUsage
                      trafficQuotaBytes={item.trafficQuotaBytes}
                      trafficUsedBytes={item.trafficUsedBytes}
                      size="sm"
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {formatDate(item.expiresAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TruncationNote shown={items.length} total={total} />
        </>
      )}
    </section>
  );
}

/** The latest admin actions, fetched on its own so the overview stays fast. */
function RecentActivityPanel() {
  const { data, isPending } = useQuery({
    queryKey: [...ADMIN_AUDIT_QUERY_KEY, "recent"],
    queryFn: () =>
      listAdminAudit({ data: { page: 1, pageSize: RECENT_ACTIVITY_LIMIT } }),
    refetchInterval: 30_000,
  });

  return (
    <section className="flex min-w-0 flex-col">
      <SectionHeader className="border-b pb-2">
        <SectionTitle>{m.admin_audit_recent_title()}</SectionTitle>
        <SectionActions>
          <Button
            size="sm"
            variant="ghost"
            render={<Link to="/admin/operations/audit" />}
          >
            {m.admin_audit_recent_view_all()}
          </Button>
        </SectionActions>
      </SectionHeader>

      {isPending ? (
        <SidebarActivitySkeleton />
      ) : data && data.rows.length > 0 ? (
        <AuditActivityList entries={data.rows} />
      ) : (
        <div className="border-b py-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollTextIcon />
              </EmptyMedia>
              <EmptyTitle>{m.admin_audit_recent_empty()}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      )}
    </section>
  );
}

/** Shown only when the list was capped at `OVERVIEW_LIST_LIMIT`. */
function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown || shown < OVERVIEW_LIST_LIMIT) return null;
  return (
    <p className="border-b px-4 py-2 text-xs text-muted-foreground lg:px-6">
      {m.admin_overview_list_truncated({ shown, total })}
    </p>
  );
}
