import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  DownloadIcon,
  ScrollTextIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { Fragment, useEffect, useState } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { targetTypeLabel } from "@/components/audit-labels";
import { AuditStatusBadge } from "@/components/audit-status-badge";
import { ListPagination } from "@/components/list-pagination";
import { SortHeader } from "@/components/sort-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import {
  auditSearchSchema,
  type AuditSearch,
  DEFAULT_AUDIT_PAGE_SIZE,
  searchToAdminFilter,
  searchToMcpFilter,
} from "@/lib/admin-audit-search";
import { downloadCsv } from "@/lib/download-csv";
import { formatDateTime } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import { AUDIT_PAGE_SIZES, type AuditSource } from "@/orpc/audit/schema";
import { m } from "@/paraglide/messages";
import {
  ADMIN_AUDIT_QUERY_KEY,
  type AdminAuditEntry,
  exportAdminAuditCsv,
  exportMcpAuditCsv,
  listAdminAudit,
  listMcpAudit,
  type McpAuditEntry,
  purgeAdminAudit,
} from "@/query/admin-audit";

import { AdminAuditDetail, McpAuditDetail } from "./_modules/audit-detail";
import { AuditToolbar } from "./_modules/audit-toolbar";
import { PurgeAuditDialog } from "./_modules/purge-audit-dialog";

export const Route = createFileRoute("/(admin)/admin/audit/")({
  validateSearch: auditSearchSchema,
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const routeNavigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const [searchResetToken, setSearchResetToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const tab: AuditSource = search.tab ?? "admin";
  const page = search.page ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE;
  const dir = search.dir ?? "desc";

  const adminFilter = searchToAdminFilter(search);
  const mcpFilter = searchToMcpFilter(search);
  const adminInput = { ...adminFilter, page, pageSize };
  const mcpInput = { ...mcpFilter, page, pageSize };

  const adminQuery = useQuery({
    queryKey: [...ADMIN_AUDIT_QUERY_KEY, "list", adminInput],
    queryFn: () => listAdminAudit({ data: adminInput }),
    placeholderData: keepPreviousData,
    enabled: tab === "admin",
  });
  const mcpQuery = useQuery({
    queryKey: [...ADMIN_AUDIT_QUERY_KEY, "mcp", mcpInput],
    queryFn: () => listMcpAudit({ data: mcpInput }),
    placeholderData: keepPreviousData,
    enabled: tab === "mcp",
  });
  const active = tab === "admin" ? adminQuery : mcpQuery;

  const total = active.data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  // A purge (or a hand-edited link) can leave the page past the end: step back.
  useEffect(() => {
    if (active.data && page > pageCount) {
      void routeNavigate({
        search: (prev) => ({
          ...prev,
          page: pageCount === 1 ? undefined : pageCount,
        }),
        replace: true,
      });
    }
  }, [active.data, page, pageCount, routeNavigate]);

  const updateSearch = (patch: Partial<AuditSearch>) => {
    void routeNavigate({
      search: (prev) => ({ ...prev, ...patch, page: undefined }),
      replace: true,
    });
  };

  const clearFilters = () => {
    setSearchResetToken((token) => token + 1);
    void routeNavigate({
      search: (prev) => ({
        tab: prev.tab,
        pageSize: prev.pageSize,
        dir: prev.dir,
      }),
      replace: true,
    });
  };

  const switchTab = (next: AuditSource) => {
    setSearchResetToken((token) => token + 1);
    void routeNavigate({
      search: (prev) => ({
        tab: next === "admin" ? undefined : next,
        pageSize: prev.pageSize,
        dir: prev.dir,
      }),
      replace: true,
    });
  };

  const filterTarget = (targetType: string, targetId: string) => {
    setSearchResetToken((token) => token + 1);
    updateSearch({ targetType, targetId });
  };

  const hasFilters =
    search.actor !== undefined ||
    search.action !== undefined ||
    search.status !== undefined ||
    search.from !== undefined ||
    search.to !== undefined ||
    (tab === "admin" &&
      (search.targetType !== undefined || search.targetId !== undefined));

  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const result =
        tab === "admin"
          ? await exportAdminAuditCsv({ data: adminFilter })
          : await exportMcpAuditCsv({ data: mcpFilter });
      downloadCsv(
        `${tab === "admin" ? "admin-audit" : "mcp-audit"}-${new Date().toISOString().slice(0, 10)}.csv`,
        result.csv,
      );
      toastManager.add({
        type: result.truncated ? "warning" : "success",
        title: result.truncated
          ? m.admin_audit_export_truncated({ count: result.count })
          : m.admin_audit_export_done({ count: result.count }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_audit_export_error(),
      });
    } finally {
      setIsExporting(false);
    }
  };

  const purgeMutation = useMutation({
    mutationFn: (olderThanDays: number) =>
      purgeAdminAudit({ data: { olderThanDays } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ADMIN_AUDIT_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_audit_purge_done({ count: result.deleted }),
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_audit_purge_error() });
    },
  });

  const toggleDir = () =>
    updateSearch({ dir: dir === "desc" ? "asc" : undefined });

  const timeHeader = (
    <SortHeader
      active
      dir={dir}
      label={m.admin_audit_col_time()}
      onClick={toggleDir}
    />
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader className="flex-wrap gap-2">
        <div className="flex flex-col gap-0.5">
          <PageHeaderTitle>{m.admin_audit_title()}</PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_audit_description()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "admin" ? (
            <Button
              variant="outline"
              onClick={() =>
                void PurgeAuditDialog.call({
                  onPurge: (days) => purgeMutation.mutateAsync(days),
                })
              }
            >
              <Trash2Icon />
              {m.admin_audit_purge()}
            </Button>
          ) : null}
          <Button
            loading={isExporting}
            variant="outline"
            onClick={() => void exportCsv()}
          >
            <DownloadIcon />
            {m.admin_audit_export()}
          </Button>
        </div>
      </PageHeader>

      <Tabs
        value={tab}
        onValueChange={(next) => switchTab(next as AuditSource)}
      >
        <TabsList>
          <TabsTab value="admin">{m.admin_audit_tab_admin()}</TabsTab>
          <TabsTab value="mcp">{m.admin_audit_tab_mcp()}</TabsTab>
        </TabsList>
      </Tabs>

      <AuditToolbar
        hasFilters={hasFilters}
        search={search}
        searchResetToken={searchResetToken}
        tab={tab}
        onChange={updateSearch}
        onClear={clearFilters}
      />

      {active.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : active.isError ? (
        <div className="flex flex-col items-center gap-4 py-16">
          <Alert variant="error" className="max-w-md">
            <AlertTitle>{m.admin_audit_load_error()}</AlertTitle>
            <AlertDescription>
              {active.error instanceof Error ? active.error.message : null}
            </AlertDescription>
          </Alert>
          <Button
            loading={active.isFetching}
            onClick={() => void active.refetch()}
          >
            {m.admin_audit_load_retry()}
          </Button>
        </div>
      ) : total > 0 ? (
        <div
          className={
            active.isPlaceholderData ? "opacity-60 transition-opacity" : ""
          }
        >
          {tab === "admin" ? (
            <AdminAuditTable
              // Expanded rows are per view: reset them with the page.
              key={JSON.stringify(adminInput)}
              rows={adminQuery.data?.rows ?? []}
              timeHeader={timeHeader}
              onFilterTarget={filterTarget}
            />
          ) : (
            <McpAuditTable
              key={JSON.stringify(mcpInput)}
              rows={mcpQuery.data?.rows ?? []}
              timeHeader={timeHeader}
            />
          )}

          <ListPagination
            link={(target) => (
              <Link
                from="/admin/audit/"
                to="/admin/audit"
                search={(prev) => ({
                  ...prev,
                  page: target === 1 ? undefined : target,
                })}
              />
            )}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            pageSizes={AUDIT_PAGE_SIZES}
            total={total}
            onPageSizeChange={(size) =>
              updateSearch({
                pageSize: size === DEFAULT_AUDIT_PAGE_SIZE ? undefined : size,
              })
            }
          />
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>
              {hasFilters
                ? m.admin_audit_empty_filtered()
                : m.admin_audit_empty()}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function ExpandButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-expanded={expanded}
      aria-label={expanded ? m.admin_audit_collapse() : m.admin_audit_expand()}
      size="icon-xs"
      variant="ghost"
      onClick={onToggle}
    >
      <ChevronRightIcon
        className={
          expanded ? "rotate-90 transition-transform" : "transition-transform"
        }
      />
    </Button>
  );
}

function useExpandedRows() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { expanded, toggle };
}

/** The entity a target points at, linked to its admin page when it has one. */
function TargetCell({ entry }: { entry: AdminAuditEntry }) {
  const { targetType, targetId } = entry;
  if (!targetType) {
    return <span className="text-muted-foreground">–</span>;
  }

  const id = targetId ?? "";
  const label = targetId ? (
    <span className="max-w-40 truncate font-mono text-xs" title={targetId}>
      {targetId}
    </span>
  ) : null;

  let content: React.ReactNode = label;
  if (targetType === "user" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ userId: id }}
        to="/admin/users/$userId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "plan" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ planId: id }}
        to="/admin/plans/$planId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "group" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ groupId: id }}
        to="/admin/proxies/groups/$groupId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "node" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ nodeId: id }}
        to="/admin/proxies/nodes/$nodeId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "server" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ serverId: id }}
        to="/admin/proxies/servers/$serverId"
      >
        {label}
      </Link>
    );
  } else if (!targetId) {
    const ids = (entry.metadata as { ids?: unknown } | null)?.ids;
    content = Array.isArray(ids) ? (
      <span className="text-xs text-muted-foreground">
        {m.admin_audit_target_bulk({ count: ids.length })}
      </span>
    ) : null;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">
        {targetTypeLabel(targetType)}
      </span>
      {content}
    </div>
  );
}

function ActorCell({
  email,
  userId,
}: {
  email: string | null;
  userId: string | null;
}) {
  if (!email) {
    return (
      <span className="text-muted-foreground">
        {m.admin_audit_actor_deleted()}
      </span>
    );
  }
  return userId ? (
    <Link
      className="text-sm hover:underline"
      params={{ userId }}
      to="/admin/users/$userId"
    >
      {email}
    </Link>
  ) : (
    <span className="text-sm">{email}</span>
  );
}

function AdminAuditTable({
  rows,
  timeHeader,
  onFilterTarget,
}: {
  rows: readonly AdminAuditEntry[];
  timeHeader: React.ReactNode;
  onFilterTarget: (targetType: string, targetId: string) => void;
}) {
  const { expanded, toggle } = useExpandedRows();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">{m.admin_audit_expand()}</span>
          </TableHead>
          <TableHead>{timeHeader}</TableHead>
          <TableHead>{m.admin_audit_col_actor()}</TableHead>
          <TableHead>{m.admin_audit_col_action()}</TableHead>
          <TableHead>{m.admin_audit_col_target()}</TableHead>
          <TableHead>{m.admin_audit_col_status()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((entry) => {
          const isOpen = expanded.has(entry.id);
          return (
            <Fragment key={entry.id}>
              <TableRow>
                <TableCell>
                  <ExpandButton
                    expanded={isOpen}
                    onToggle={() => toggle(entry.id)}
                  />
                </TableCell>
                <TableCell>
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ActorCell
                      email={entry.actorEmail}
                      userId={entry.actorUserId}
                    />
                    {entry.impersonatedBy ? (
                      <Badge variant="warning">
                        {m.admin_audit_impersonated()}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{entry.action}</span>
                </TableCell>
                <TableCell>
                  <TargetCell entry={entry} />
                </TableCell>
                <TableCell>
                  <AuditStatusBadge status={entry.status} />
                </TableCell>
              </TableRow>
              {isOpen ? (
                <TableRow>
                  <TableCell className="bg-muted/16" colSpan={6}>
                    <AdminAuditDetail
                      entry={entry}
                      onFilterTarget={onFilterTarget}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function McpAuditTable({
  rows,
  timeHeader,
}: {
  rows: readonly McpAuditEntry[];
  timeHeader: React.ReactNode;
}) {
  const { expanded, toggle } = useExpandedRows();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">{m.admin_audit_expand()}</span>
          </TableHead>
          <TableHead>{timeHeader}</TableHead>
          <TableHead>{m.admin_audit_col_actor()}</TableHead>
          <TableHead>{m.admin_audit_col_tool()}</TableHead>
          <TableHead>{m.admin_audit_col_status()}</TableHead>
          <TableHead>{m.admin_audit_col_duration()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((entry) => {
          const isOpen = expanded.has(entry.id);
          return (
            <Fragment key={entry.id}>
              <TableRow>
                <TableCell>
                  <ExpandButton
                    expanded={isOpen}
                    onToggle={() => toggle(entry.id)}
                  />
                </TableCell>
                <TableCell>
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </TableCell>
                <TableCell>
                  <ActorCell
                    email={entry.actorEmail}
                    userId={entry.actorUserId}
                  />
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{entry.tool}</span>
                </TableCell>
                <TableCell>
                  <AuditStatusBadge status={entry.status} />
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {entry.durationMs === null
                      ? "–"
                      : m.admin_audit_duration_ms({ ms: entry.durationMs })}
                  </span>
                </TableCell>
              </TableRow>
              {isOpen ? (
                <TableRow>
                  <TableCell className="bg-muted/16" colSpan={6}>
                    <McpAuditDetail entry={entry} />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
