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
  XIcon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderTitle,
  PageToolbar,
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import {
  InspectorSkeleton,
  TableSkeleton,
} from "@/components/app-shell/skeletons";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { useMediaQuery } from "@/hooks/use-media-query";
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

export const Route = createFileRoute("/(admin)/admin/operations/audit/")({
  validateSearch: auditSearchSchema,
  component: RouteComponent,
});

type AuditSelection =
  | { kind: "admin"; entry: AdminAuditEntry }
  | { kind: "mcp"; entry: McpAuditEntry };

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const routeNavigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const [searchResetToken, setSearchResetToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [selection, setSelection] = useState<AuditSelection | null>(null);
  const isWide = useMediaQuery("xl");

  const tab: AuditSource = search.tab ?? "admin";
  const page = search.page ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE;
  const dir = search.dir ?? "desc";

  const adminFilter = searchToAdminFilter(search);
  const mcpFilter = searchToMcpFilter(search);
  const adminInput = { ...adminFilter, page, pageSize };
  const mcpInput = { ...mcpFilter, page, pageSize };
  const viewKey = JSON.stringify([tab, adminInput, mcpInput]);

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

  useEffect(() => {
    setSelection(null);
  }, [viewKey]);

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
    <>
      <PageHeader>
        <div className="flex min-w-0 items-baseline gap-3">
          <PageHeaderTitle>{m.admin_audit_title()}</PageHeaderTitle>
          <PageHeaderDescription className="hidden lg:block">
            {m.admin_audit_description()}
          </PageHeaderDescription>
        </div>
        <PageHeaderActions>
          {tab === "admin" ? (
            <Button
              size="sm"
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
            size="sm"
            variant="outline"
            onClick={() => void exportCsv()}
          >
            <DownloadIcon />
            {m.admin_audit_export()}
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <PageToolbar>
        <div className="flex w-full items-center gap-2">
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
        </div>
      </PageToolbar>

      <PageContent>
        {active.isPending ? (
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <TableSkeleton columns={6} rows={12} />
            <InspectorSkeleton className="hidden xl:flex" />
          </div>
        ) : active.isError ? (
          <div className="flex flex-col items-start gap-4 py-12">
            <Alert variant="error" className="max-w-md">
              <AlertTitle>{m.admin_audit_load_error()}</AlertTitle>
              <AlertDescription>
                {active.error instanceof Error ? active.error.message : null}
              </AlertDescription>
            </Alert>
            <Button
              loading={active.isFetching}
              size="sm"
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
            <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
              <div className="min-w-0">
                {tab === "admin" ? (
                  <AdminAuditTable
                    rows={adminQuery.data?.rows ?? []}
                    selectedId={
                      selection?.kind === "admin" ? selection.entry.id : null
                    }
                    timeHeader={timeHeader}
                    onSelect={(entry) => setSelection({ kind: "admin", entry })}
                  />
                ) : (
                  <McpAuditTable
                    rows={mcpQuery.data?.rows ?? []}
                    selectedId={
                      selection?.kind === "mcp" ? selection.entry.id : null
                    }
                    timeHeader={timeHeader}
                    onSelect={(entry) => setSelection({ kind: "mcp", entry })}
                  />
                )}
              </div>

              <aside className="hidden min-w-0 xl:block">
                <AuditInspector
                  selection={selection}
                  onFilterTarget={filterTarget}
                  onClear={() => setSelection(null)}
                />
              </aside>
            </div>

            <div className="border-t">
              <ListPagination
                link={(target) => (
                  <Link
                    from="/admin/operations/audit/"
                    to="/admin/operations/audit"
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
                    pageSize:
                      size === DEFAULT_AUDIT_PAGE_SIZE ? undefined : size,
                  })
                }
              />
            </div>
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
      </PageContent>

      <Sheet
        open={!isWide && selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        <SheetContent className="max-w-2xl" showCloseButton={false}>
          <SheetHeader>
            <div className="flex items-start justify-between gap-3">
              <SheetTitle>{m.admin_page_audit_details()}</SheetTitle>
              <Button
                aria-label={m.admin_page_audit_close()}
                size="icon-sm"
                variant="ghost"
                onClick={() => setSelection(null)}
              >
                <XIcon />
              </Button>
            </div>
            <SheetDescription>
              {m.admin_page_audit_select_prompt()}
            </SheetDescription>
          </SheetHeader>
          <SheetPanel>
            <AuditInspector
              embedded
              selection={selection}
              onFilterTarget={(targetType, targetId) => {
                setSelection(null);
                filterTarget(targetType, targetId);
              }}
              onClear={() => setSelection(null)}
            />
          </SheetPanel>
        </SheetContent>
      </Sheet>
    </>
  );
}

function SelectEntryButton({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      aria-label={selected ? m.admin_audit_collapse() : m.admin_audit_expand()}
      size="icon-xs"
      variant="ghost"
      onClick={onSelect}
    >
      <ChevronRightIcon
        className={selected ? "rotate-90 transition-transform" : undefined}
      />
    </Button>
  );
}

function AuditInspector({
  selection,
  embedded = false,
  onFilterTarget,
  onClear,
}: {
  selection: AuditSelection | null;
  embedded?: boolean;
  onFilterTarget: (targetType: string, targetId: string) => void;
  onClear: () => void;
}) {
  return (
    <section
      className={
        embedded
          ? "flex min-w-0 flex-col gap-4"
          : "sticky top-[calc(var(--page-header-h)+var(--page-toolbar-h))] flex min-w-0 flex-col gap-4"
      }
      data-slot="audit-inspector"
    >
      <SectionHeader className="border-b pb-2">
        <SectionTitle>{m.admin_page_audit_details()}</SectionTitle>
        {selection ? (
          <Button
            aria-label={m.admin_page_audit_clear_selection()}
            size="icon-xs"
            variant="ghost"
            onClick={onClear}
          >
            <XIcon />
          </Button>
        ) : null}
      </SectionHeader>
      {!selection ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {m.admin_page_audit_select_prompt()}
        </p>
      ) : selection.kind === "admin" ? (
        <AdminAuditDetail
          entry={selection.entry}
          onFilterTarget={onFilterTarget}
        />
      ) : (
        <McpAuditDetail entry={selection.entry} />
      )}
    </section>
  );
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
        to="/admin/access/users/$userId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "plan" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ planId: id }}
        to="/admin/access/plans/$planId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "group" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ groupId: id }}
        to="/admin/access/groups/$groupId"
      >
        {label}
      </Link>
    );
  } else if (targetType === "node" && id) {
    content = (
      <a className="hover:underline" href={`/admin/proxies/nodes/${id}`}>
        {label}
      </a>
    );
  } else if (targetType === "server" && id) {
    content = (
      <Link
        className="hover:underline"
        params={{ serverId: id }}
        to="/admin/servers/$serverId/overview"
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
      to="/admin/access/users/$userId"
    >
      {email}
    </Link>
  ) : (
    <span className="text-sm">{email}</span>
  );
}

function AdminAuditTable({
  rows,
  selectedId,
  timeHeader,
  onSelect,
}: {
  rows: readonly AdminAuditEntry[];
  selectedId: string | null;
  timeHeader: React.ReactNode;
  onSelect: (entry: AdminAuditEntry) => void;
}) {
  return (
    <Table variant="pane">
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">{m.admin_audit_expand()}</span>
          </TableHead>
          <TableHead>{timeHeader}</TableHead>
          <TableHead className="hidden md:table-cell">
            {m.admin_audit_col_actor()}
          </TableHead>
          <TableHead>{m.admin_audit_col_action()}</TableHead>
          <TableHead className="hidden lg:table-cell">
            {m.admin_audit_col_target()}
          </TableHead>
          <TableHead>{m.admin_audit_col_status()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((entry) => (
          <TableRow
            data-state={selectedId === entry.id ? "selected" : undefined}
            key={entry.id}
          >
            <TableCell>
              <SelectEntryButton
                selected={selectedId === entry.id}
                onSelect={() => onSelect(entry)}
              />
            </TableCell>
            <TableCell>
              <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {formatDateTime(entry.createdAt)}
              </span>
            </TableCell>
            <TableCell className="hidden md:table-cell">
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
            <TableCell className="hidden lg:table-cell">
              <TargetCell entry={entry} />
            </TableCell>
            <TableCell>
              <AuditStatusBadge status={entry.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function McpAuditTable({
  rows,
  selectedId,
  timeHeader,
  onSelect,
}: {
  rows: readonly McpAuditEntry[];
  selectedId: string | null;
  timeHeader: React.ReactNode;
  onSelect: (entry: McpAuditEntry) => void;
}) {
  return (
    <Table variant="pane">
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">{m.admin_audit_expand()}</span>
          </TableHead>
          <TableHead>{timeHeader}</TableHead>
          <TableHead className="hidden md:table-cell">
            {m.admin_audit_col_actor()}
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            {m.admin_audit_col_tool()}
          </TableHead>
          <TableHead>{m.admin_audit_col_status()}</TableHead>
          <TableHead>{m.admin_audit_col_duration()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((entry) => (
          <TableRow
            data-state={selectedId === entry.id ? "selected" : undefined}
            key={entry.id}
          >
            <TableCell>
              <SelectEntryButton
                selected={selectedId === entry.id}
                onSelect={() => onSelect(entry)}
              />
            </TableCell>
            <TableCell>
              <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {formatDateTime(entry.createdAt)}
              </span>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <ActorCell email={entry.actorEmail} userId={entry.actorUserId} />
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <span className="font-mono text-xs">{entry.tool}</span>
            </TableCell>
            <TableCell>
              <AuditStatusBadge status={entry.status} />
            </TableCell>
            <TableCell>
              <span className="text-xs text-muted-foreground tabular-nums">
                {entry.durationMs === null
                  ? "–"
                  : m.admin_audit_duration_ms({ ms: entry.durationMs })}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
