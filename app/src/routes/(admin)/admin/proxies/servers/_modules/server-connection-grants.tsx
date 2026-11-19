import { DownloadIcon } from "lucide-react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  grantDisplayStatus,
  REDEMPTION_STALE_MS,
  type GrantDisplayStatus,
} from "@/lib/agent-connection";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

import type { ConnectionGrantRow } from "./connection-types";

const statusLabel: Record<GrantDisplayStatus, () => string> = {
  issued: m.admin_proxies_servers_connection_grant_status_issued,
  expired: m.admin_proxies_servers_connection_grant_status_expired,
  redeeming: m.admin_proxies_servers_connection_grant_status_redeeming,
  redeemed: m.admin_proxies_servers_connection_grant_status_redeemed,
  revoked: m.admin_proxies_servers_connection_grant_status_revoked,
};

const statusTone: Record<
  GrantDisplayStatus,
  "success" | "warning" | "error" | "outline"
> = {
  issued: "success",
  expired: "warning",
  redeeming: "warning",
  redeemed: "outline",
  revoked: "outline",
};

const modeLabel: Record<string, () => string> = {
  enroll: m.admin_proxies_servers_connection_grant_mode_enroll,
  replace: m.admin_proxies_servers_connection_grant_mode_replace,
};

export interface ServerConnectionGrantsProps {
  grants: readonly ConnectionGrantRow[];
  /** Active generation that stays in service until a replacement proves. */
  activeGeneration: number | null;
  revoking: boolean;
  onRevoke: (grant: ConnectionGrantRow) => void;
}

/** Enrollment grant history, expiry, fixed-script download and recovery. */
export function ServerConnectionGrants({
  grants,
  activeGeneration,
  revoking,
  onRevoke,
}: ServerConnectionGrantsProps): React.ReactElement {
  const now = Date.now();

  return (
    <section
      data-slot="server-connection-grants"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div>
        <h2 className="font-medium">
          {m.admin_proxies_servers_connection_grants_title()}
        </h2>
      </div>

      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_proxies_servers_connection_grants_empty()}
        </p>
      ) : (
        <ul className="divide-y">
          {grants.map((grant) => {
            const status = grantDisplayStatus(grant, now);
            const staleClaim =
              status === "redeeming" &&
              now - new Date(grant.claimedAt ?? grant.createdAt).getTime() >
                REDEMPTION_STALE_MS;
            const revocable = status === "issued" || status === "redeeming";
            return (
              <li
                key={grant.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusTone[status]}>
                      {statusLabel[status]()}
                    </Badge>
                    <span className="text-sm font-medium">
                      {modeLabel[grant.mode]
                        ? modeLabel[grant.mode]()
                        : grant.mode}
                    </span>
                    {grant.release ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {m.admin_proxies_servers_connection_grant_release({
                          version: grant.release,
                        })}
                      </span>
                    ) : null}
                  </div>
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {m.admin_proxies_servers_connection_grant_created({
                        date: formatDateTime(grant.createdAt),
                      })}
                    </span>
                    <span>
                      {m.admin_proxies_servers_connection_grant_expires({
                        date: formatDateTime(grant.expiresAt),
                      })}
                    </span>
                    {grant.claimedAt ? (
                      <span>
                        {m.admin_proxies_servers_connection_grant_claimed({
                          date: formatDateTime(grant.claimedAt),
                        })}
                      </span>
                    ) : null}
                    {grant.redeemedAt ? (
                      <span>
                        {m.admin_proxies_servers_connection_grant_redeemed({
                          date: formatDateTime(grant.redeemedAt),
                        })}
                      </span>
                    ) : null}
                  </p>
                  {grant.capabilities.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {grant.capabilities.map((capability) => (
                        <li key={capability}>
                          <Badge variant="outline" className="font-mono">
                            {capability}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {staleClaim ? (
                    <p className="text-xs text-destructive">
                      {m.admin_proxies_servers_connection_grant_recovery()}
                    </p>
                  ) : null}
                  {grant.mode === "replace" &&
                  activeGeneration !== null &&
                  (status === "issued" || status === "redeeming") ? (
                    <p className="text-xs text-muted-foreground">
                      {m.admin_proxies_servers_connection_grant_replace_active_note(
                        { generation: activeGeneration },
                      )}
                    </p>
                  ) : null}
                  {status === "expired" ? (
                    <p className="text-xs text-muted-foreground">
                      {m.admin_proxies_servers_connection_grant_expired_recovery()}
                    </p>
                  ) : null}
                </div>
                {status === "issued" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <a
                          href={`/api/admin/servers/${encodeURIComponent(grant.serverId)}/installation/script/${encodeURIComponent(grant.id)}`}
                          download="blossom-agent-install.sh"
                        />
                      }
                    >
                      <DownloadIcon />
                      {m.admin_proxies_servers_connection_grant_download()}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      disabled={revoking}
                      onClick={() => onRevoke(grant)}
                    >
                      {m.admin_proxies_servers_connection_grant_revoke()}
                    </Button>
                  </div>
                ) : revocable ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={revoking}
                    onClick={() => onRevoke(grant)}
                  >
                    {m.admin_proxies_servers_connection_grant_revoke()}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
