import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  CheckCircle2Icon,
  CreditCardIcon,
  HourglassIcon,
  NetworkIcon,
  ScrollTextIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { AuditActivityList } from "@/components/audit-activity-list";
import { SubscriptionQuotaUsage } from "@/components/subscriptions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  EXPIRING_SOON_DAYS,
  OVERVIEW_LIST_LIMIT,
  QUOTA_WARNING_PERCENT,
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

function RouteComponent() {
  const { data, isFetching, isPending, error, refetch } = useQuery({
    queryKey: ADMIN_OVERVIEW_QUERY_KEY,
    queryFn: () => getAdminOverview(),
    refetchInterval: 30_000,
  });

  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
        <span className="sr-only">{m.admin_overview_loading()}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <Alert variant="error" className="max-w-md">
          <AlertTitle>{m.admin_overview_error_title()}</AlertTitle>
          <AlertDescription>
            {m.admin_overview_error_description()}
          </AlertDescription>
        </Alert>
        <Button loading={isFetching} onClick={() => void refetch()}>
          {m.admin_overview_error_retry()}
        </Button>
      </div>
    );
  }

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
    <div className="flex flex-col gap-6 p-4">
      <PageHeader>
        <PageHeaderTitle className="text-2xl">
          {m.admin_nav_dashboard()}
        </PageHeaderTitle>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          icon={<UsersIcon />}
          label={m.admin_overview_stat_users()}
          value={users.total}
          description={
            users.banned > 0
              ? m.admin_overview_stat_users_banned({ count: users.banned })
              : undefined
          }
        />
        <StatTile
          icon={<CreditCardIcon />}
          label={m.admin_overview_stat_subscriptions()}
          value={subscriptions.active}
          description={m.admin_overview_stat_subscriptions_total({
            count: subscriptions.total,
          })}
        />
        <StatTile
          icon={<ServerIcon />}
          label={m.admin_overview_stat_servers()}
          value={`${servers.online} / ${servers.total}`}
          description={
            servers.attention > 0
              ? m.admin_overview_stat_servers_attention({
                  count: servers.attention,
                })
              : m.admin_overview_stat_servers_total({ count: servers.total })
          }
          warning={servers.attention > 0}
        />
        <StatTile
          icon={<NetworkIcon />}
          label={m.admin_overview_stat_nodes()}
          value={nodes.enabled}
          description={m.admin_overview_stat_nodes_total({
            count: nodes.total,
          })}
        />
        <StatTile
          icon={<ActivityIcon />}
          label={m.admin_overview_stat_traffic()}
          value={formatBytes(traffic.last24hBytes)}
          description={m.admin_overview_stat_traffic_30d({
            bytes: formatBytes(traffic.last30dBytes),
          })}
        />
      </div>

      <ServersAttentionCard
        hasServers={servers.total > 0}
        items={attentionServers}
        total={servers.attention}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SubscriptionListCard
          title={m.admin_overview_expiring_title()}
          description={m.admin_overview_expiring_description({
            days: EXPIRING_SOON_DAYS,
          })}
          emptyLabel={m.admin_overview_expiring_empty()}
          icon={<HourglassIcon />}
          items={expiringSubscriptions}
          total={subscriptions.expiringSoon}
        />
        <SubscriptionListCard
          title={m.admin_overview_quota_title()}
          description={m.admin_overview_quota_description({
            percent: QUOTA_WARNING_PERCENT,
          })}
          emptyLabel={m.admin_overview_quota_empty()}
          icon={<ActivityIcon />}
          items={nearQuotaSubscriptions}
          total={subscriptions.nearQuota}
        />
      </div>

      <RecentActivityCard />
    </div>
  );
}

const RECENT_ACTIVITY_LIMIT = 8;

/** The latest admin actions, fetched on its own so the overview stays fast. */
function RecentActivityCard() {
  const { data, isPending } = useQuery({
    queryKey: [...ADMIN_AUDIT_QUERY_KEY, "recent"],
    queryFn: () =>
      listAdminAudit({ data: { page: 1, pageSize: RECENT_ACTIVITY_LIMIT } }),
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.admin_audit_recent_title()}</CardTitle>
        <CardDescription>{m.admin_audit_recent_description()}</CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/audit" />}
          >
            {m.admin_audit_recent_view_all()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : data && data.rows.length > 0 ? (
          <AuditActivityList entries={data.rows} />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollTextIcon />
              </EmptyMedia>
              <EmptyTitle>{m.admin_audit_recent_empty()}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  value,
  description,
  warning = false,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  description?: string;
  warning?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 [&_svg]:size-4">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {description ? (
          <CardDescription
            className={warning ? "text-warning-foreground" : undefined}
          >
            {description}
          </CardDescription>
        ) : null}
      </CardHeader>
    </Card>
  );
}

function ServerHealthBadge({ item }: { item: ServerAttentionItem }) {
  const label = {
    agent_offline: m.admin_proxies_servers_status_offline(),
    runtime_error: m.admin_proxies_servers_status_runtime_error(),
    config_error: m.admin_proxies_servers_status_config_error(),
    degraded: m.admin_proxies_servers_status_degraded(),
    online: m.admin_proxies_servers_status_online(),
    unknown: m.admin_proxies_servers_status_unknown(),
    disabled: m.admin_proxies_servers_status_disabled(),
  }[item.health];
  const dotClass =
    item.health === "online"
      ? "bg-emerald-500"
      : item.health === "degraded" || item.health === "unknown"
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <Badge variant="outline" title={item.lastErrorMessage ?? undefined}>
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${dotClass}`}
      />
      {label}
    </Badge>
  );
}

function ServersAttentionCard({
  hasServers,
  items,
  total,
}: {
  hasServers: boolean;
  items: ServerAttentionItem[];
  total: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.admin_overview_servers_title()}</CardTitle>
        <CardDescription>
          {m.admin_overview_servers_description()}
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/proxies/servers" />}
          >
            {m.admin_overview_servers_view_all()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {hasServers ? <CheckCircle2Icon /> : <ServerIcon />}
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
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to="/admin/proxies/servers/$serverId"
                    params={{ serverId: item.id }}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md py-3 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{item.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {item.address}
                      </span>
                      {item.lastErrorMessage &&
                      ["degraded", "config_error", "runtime_error"].includes(
                        item.health,
                      ) ? (
                        <span className="line-clamp-1 text-xs text-destructive">
                          {item.lastErrorMessage}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {item.pendingConfigChanges > 0 ? (
                        <Badge variant="warning">
                          {m.admin_overview_servers_pending({
                            count: item.pendingConfigChanges,
                          })}
                        </Badge>
                      ) : null}
                      <ServerHealthBadge item={item} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <TruncationNote shown={items.length} total={total} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SubscriptionListCard({
  title,
  description,
  emptyLabel,
  icon,
  items,
  total,
}: {
  title: string;
  description: string;
  emptyLabel: string;
  icon: ReactNode;
  items: OverviewSubscriptionItem[];
  total: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">{icon}</EmptyMedia>
              <EmptyTitle>{emptyLabel}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to="/admin/users/$userId"
                    params={{ userId: item.userId }}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md py-3 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">
                        {item.userName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {item.userEmail}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.planName} ·{" "}
                        {m.admin_overview_subscription_expires({
                          date: formatDate(item.expiresAt),
                        })}
                      </span>
                    </div>
                    <SubscriptionQuotaUsage
                      trafficQuotaBytes={item.trafficQuotaBytes}
                      trafficUsedBytes={item.trafficUsedBytes}
                      size="sm"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            <TruncationNote shown={items.length} total={total} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Shown only when the list was capped at `OVERVIEW_LIST_LIMIT`. */
function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown || shown < OVERVIEW_LIST_LIMIT) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {m.admin_overview_list_truncated({ shown, total })}
    </p>
  );
}
