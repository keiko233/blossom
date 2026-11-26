import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CopyIcon, PlugIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { FormSkeleton } from "@/components/app-shell/skeletons";
import { StatStrip, StatStripItem } from "@/components/app-shell/stat-strip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  getMcpAdminOverview,
  MCP_ADMIN_QUERY_KEY,
  type McpAdminOverview,
} from "@/query/mcp-admin";

export const Route = createFileRoute("/(admin)/admin/operations/mcp/")({
  component: RouteComponent,
});

type Client = McpAdminOverview["clients"][number];
type Consent = McpAdminOverview["consents"][number];
type Audit = McpAdminOverview["audits"][number];

function ScopeList({ scopes }: { scopes: string[] | null }) {
  return scopes && scopes.length > 0 ? (
    <div className="flex max-w-80 flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge key={scope} variant="outline">
          {scope}
        </Badge>
      ))}
    </div>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function ConnectionRow({ label, value }: { label: string; value: string }) {
  const [isCopying, setIsCopying] = useState(false);

  const copy = async () => {
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({ type: "success", title: m.admin_mcp_copied() });
    } catch {
      toastManager.add({ type: "error", title: m.admin_mcp_copy_failed() });
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <div className="grid gap-2 border-t py-3 first:border-t-0 first:pt-0 last:pb-0 md:grid-cols-[14rem_minmax(0,1fr)_auto] md:items-center">
      <span className="text-sm font-medium">{label}</span>
      <code className="min-w-0 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
        {value}
      </code>
      <Button
        aria-label={m.admin_mcp_copy()}
        loading={isCopying}
        onClick={() => void copy()}
        size="icon"
        variant="ghost"
      >
        <CopyIcon />
      </Button>
    </div>
  );
}

function ClientsTable({ clients }: { clients: Client[] }) {
  if (clients.length === 0) {
    return <EmptyPanel>{m.admin_mcp_clients_empty()}</EmptyPanel>;
  }

  return (
    <Table variant="pane">
      <TableHeader>
        <TableRow>
          <TableHead>{m.admin_mcp_col_client()}</TableHead>
          <TableHead className="hidden md:table-cell">
            {m.admin_mcp_col_auth()}
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            {m.admin_mcp_col_scopes()}
          </TableHead>
          <TableHead>{m.admin_mcp_col_status()}</TableHead>
          <TableHead className="hidden md:table-cell">
            {m.admin_mcp_col_created()}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((client) => (
          <TableRow key={client.id}>
            <TableCell>
              <div className="flex max-w-72 flex-col gap-0.5">
                <span className="font-medium">
                  {client.name || m.admin_mcp_unnamed_client()}
                </span>
                <code className="truncate text-xs text-muted-foreground">
                  {client.clientId}
                </code>
              </div>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <div className="flex flex-col gap-0.5 text-xs">
                <span>
                  {client.isPublic
                    ? m.admin_mcp_public_client()
                    : m.admin_mcp_confidential_client()}
                </span>
                <span className="text-muted-foreground">
                  {client.requirePKCE
                    ? m.admin_mcp_pkce_required()
                    : client.tokenEndpointAuthMethod || "—"}
                </span>
              </div>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <ScopeList scopes={client.scopes} />
            </TableCell>
            <TableCell>
              <Badge variant={client.disabled ? "error" : "success"}>
                {client.disabled
                  ? m.admin_mcp_disabled()
                  : m.admin_mcp_enabled()}
              </Badge>
            </TableCell>
            <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
              {client.createdAt ? formatDateTime(client.createdAt) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConsentsTable({ consents }: { consents: Consent[] }) {
  if (consents.length === 0) {
    return <EmptyPanel>{m.admin_mcp_consents_empty()}</EmptyPanel>;
  }

  return (
    <Table variant="pane">
      <TableHeader>
        <TableRow>
          <TableHead>{m.admin_mcp_col_user()}</TableHead>
          <TableHead className="hidden md:table-cell">
            {m.admin_mcp_col_client()}
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            {m.admin_mcp_col_scopes()}
          </TableHead>
          <TableHead>{m.admin_mcp_col_created()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {consents.map((consent) => (
          <TableRow key={consent.id}>
            <TableCell>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {consent.userName || m.admin_mcp_deleted_user()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {consent.userEmail || consent.userId || "—"}
                </span>
              </div>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <div className="flex max-w-72 flex-col gap-0.5">
                <span>
                  {consent.clientName || m.admin_mcp_unnamed_client()}
                </span>
                <code className="truncate text-xs text-muted-foreground">
                  {consent.clientId}
                </code>
              </div>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <ScopeList scopes={consent.scopes} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
              {consent.createdAt ? formatDateTime(consent.createdAt) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AuditsTable({ audits }: { audits: Audit[] }) {
  if (audits.length === 0) {
    return <EmptyPanel>{m.admin_mcp_audits_empty()}</EmptyPanel>;
  }

  return (
    <Table variant="pane">
      <TableHeader>
        <TableRow>
          <TableHead>{m.admin_mcp_col_time()}</TableHead>
          <TableHead className="hidden md:table-cell">
            {m.admin_mcp_col_tool()}
          </TableHead>
          <TableHead>{m.admin_mcp_col_actor()}</TableHead>
          <TableHead className="hidden lg:table-cell">
            {m.admin_mcp_col_source()}
          </TableHead>
          <TableHead>{m.admin_mcp_col_result()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {audits.map((audit) => (
          <TableRow key={audit.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {formatDateTime(audit.createdAt)}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <code className="text-xs">{audit.tool}</code>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-0.5">
                <span>{audit.actorName || m.admin_mcp_unknown_actor()}</span>
                {audit.actorEmail ? (
                  <span className="text-xs text-muted-foreground">
                    {audit.actorEmail}
                  </span>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              {audit.source}
            </TableCell>
            <TableCell>
              <div className="flex max-w-80 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={audit.status === "success" ? "success" : "error"}
                  >
                    {audit.status}
                  </Badge>
                  {audit.durationMs === null ? null : (
                    <span className="text-xs text-muted-foreground">
                      {audit.durationMs} ms
                    </span>
                  )}
                </div>
                {audit.redactedError ? (
                  <span className="truncate text-xs text-destructive-foreground">
                    {audit.redactedError}
                  </span>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-40 items-center justify-center border-y text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function RouteComponent(): React.ReactElement {
  const { data, isPending, isError } = useQuery({
    queryKey: MCP_ADMIN_QUERY_KEY,
    queryFn: () => getMcpAdminOverview(),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>{m.admin_mcp_title()}</PageHeaderTitle>
        <PageHeaderActions>
          <Badge variant="success">
            <span className="size-1.5 rounded-full bg-success" />
            {m.admin_mcp_enabled()}
          </Badge>
        </PageHeaderActions>
      </PageHeader>

      {isPending ? (
        <PageContent width="form" className="[--page-toolbar-h:0rem]">
          <FormSkeleton fields={4} />
        </PageContent>
      ) : isError || !data ? (
        <PageContent width="form" className="[--page-toolbar-h:0rem]">
          <Alert variant="error">
            <AlertDescription>{m.admin_mcp_load_error()}</AlertDescription>
          </Alert>
        </PageContent>
      ) : (
        <PageContent width="form" className="[--page-toolbar-h:0rem]">
          <section className="flex min-w-0 flex-col gap-3">
            <SectionHeader>
              <div className="flex min-w-0 flex-col gap-0.5">
                <SectionTitle>{m.admin_mcp_connection_title()}</SectionTitle>
                <span className="text-xs text-muted-foreground">
                  {m.admin_mcp_connection_description()}
                </span>
              </div>
              <PlugIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
            </SectionHeader>
            <div>
              <ConnectionRow
                label={m.admin_mcp_endpoint()}
                value={data.connection.endpoint}
              />
              <ConnectionRow
                label={m.admin_mcp_authorization_metadata()}
                value={data.connection.authorizationServerMetadata}
              />
              <ConnectionRow
                label={m.admin_mcp_resource_metadata()}
                value={data.connection.protectedResourceMetadata}
              />
            </div>
          </section>

          <StatStrip columns={3}>
            <StatStripItem
              label={m.admin_mcp_clients()}
              value={data.stats.clientCount}
            />
            <StatStripItem
              label={m.admin_mcp_consents()}
              value={data.stats.consentCount}
            />
            <StatStripItem
              label={m.admin_mcp_audits()}
              value={data.stats.auditCount}
            />
          </StatStrip>

          <Tabs className="border-t pt-3" defaultValue="clients">
            <TabsList variant="underline">
              <TabsTab value="clients">{m.admin_mcp_clients()}</TabsTab>
              <TabsTab value="consents">{m.admin_mcp_consents()}</TabsTab>
              <TabsTab value="audits">{m.admin_mcp_audits()}</TabsTab>
            </TabsList>
            <TabsPanel value="clients">
              <ClientsTable clients={data.clients} />
            </TabsPanel>
            <TabsPanel value="consents">
              <ConsentsTable consents={data.consents} />
            </TabsPanel>
            <TabsPanel value="audits">
              <AuditsTable audits={data.audits} />
            </TabsPanel>
          </Tabs>
        </PageContent>
      )}
    </>
  );
}
