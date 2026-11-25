import { CheckIcon, CopyIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { serverWorkspaceStatus } from "@/lib/server-workspace";
import { m } from "@/paraglide/messages";
import type { ServerDTO, ServerListItem } from "@/query/servers";

import { serverStatusContent } from "./server-status";

export interface ServerIdentitySectionProps {
  server: ServerDTO;
  item: ServerListItem | undefined;
}

/** Flat identity facts for the Overview rail; no card or page header. */
export function ServerIdentitySection({
  server,
  item,
}: ServerIdentitySectionProps): React.ReactElement {
  const status = serverWorkspaceStatus(server);
  const content = serverStatusContent(status);
  const showLastError =
    Boolean(server.lastErrorMessage) &&
    ["degraded", "config_error", "runtime_error"].includes(status);
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(server.address);
      setCopied(true);
      toastManager.add({
        type: "success",
        title: m.admin_server_ws_address_copied(),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_server_ws_address_copy_failed(),
      });
    }
  };

  const transport =
    server.transportMode === "ws" && server.wsConnectedAt
      ? m.admin_proxies_servers_connection_transport_ws()
      : m.admin_proxies_servers_connection_transport_http();

  return (
    <section
      data-slot="server-identity"
      className="flex flex-col gap-3"
      aria-labelledby="server-identity-title"
    >
      <SectionHeader>
        <SectionTitle id="server-identity-title">
          {m.admin_server_ws_identity_title()}
        </SectionTitle>
      </SectionHeader>

      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{m.admin_server_ws_address()}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono">{server.address}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={m.admin_server_ws_copy_address()}
            onClick={() => void copyAddress()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </dd>

        {server.remark ? (
          <>
            <dt className="text-muted-foreground">
              {m.admin_server_ws_remark()}
            </dt>
            <dd className="min-w-0 truncate">{server.remark}</dd>
          </>
        ) : null}

        <dt className="text-muted-foreground">{m.admin_server_ws_status()}</dt>
        <dd className="flex items-center gap-1.5">
          <StatusDot tone={content.tone} label={content.label()} />
          <span>{content.label()}</span>
        </dd>

        <dt className="text-muted-foreground">
          {m.admin_proxies_servers_connection_transport_label()}
        </dt>
        <dd>{transport}</dd>

        <dt className="text-muted-foreground">
          {m.admin_proxies_servers_connection_last_seen_label()}
        </dt>
        <dd className="tabular-nums">
          {server.lastSeenAt
            ? formatDateTime(server.lastSeenAt)
            : m.admin_proxies_servers_connection_never()}
        </dd>

        <dt className="text-muted-foreground">
          {m.admin_server_ws_pending_changes()}
        </dt>
        <dd className="flex min-w-0 flex-col gap-0.5">
          {item ? (
            <span className="tabular-nums">
              {m.admin_proxies_servers_pending_changes({
                count: item.pendingConfigChanges,
              })}
            </span>
          ) : (
            <Skeleton className="h-4 w-8" />
          )}
          <span className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_pending_changes_help()}
          </span>
        </dd>

        {showLastError ? (
          <>
            <dt className="text-muted-foreground">
              {m.admin_server_ws_last_error()}
            </dt>
            <dd className="wrap-anywhere text-destructive">
              {server.lastErrorMessage}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
