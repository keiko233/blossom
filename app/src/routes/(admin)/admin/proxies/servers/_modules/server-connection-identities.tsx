import type React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

import type { ConnectionIdentityRow } from "./connection-types";

const statusLabel: Record<string, () => string> = {
  active: m.admin_proxies_servers_connection_identity_status_active,
  pending: m.admin_proxies_servers_connection_identity_status_pending,
  revoked: m.admin_proxies_servers_connection_identity_status_revoked,
  superseded: m.admin_proxies_servers_connection_identity_status_superseded,
};

const statusTone: Record<string, "success" | "warning" | "error" | "outline"> =
  {
    active: "success",
    pending: "warning",
    revoked: "error",
    superseded: "outline",
  };

export interface ServerConnectionIdentitiesProps {
  identities: readonly ConnectionIdentityRow[];
  revoking: boolean;
  onRevoke: (identity: ConnectionIdentityRow) => void;
}

/** OAuth machine identities, including history. Pending is not success. */
export function ServerConnectionIdentities({
  identities,
  revoking,
  onRevoke,
}: ServerConnectionIdentitiesProps): React.ReactElement {
  const hasPending = identities.some(
    (identity) => identity.status === "pending",
  );
  const hasActive = identities.some((identity) => identity.status === "active");

  return (
    <section
      data-slot="server-connection-identities"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div>
        <h2 className="font-medium">
          {m.admin_proxies_servers_connection_oauth_title()}
        </h2>
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_oauth_description()}
        </p>
      </div>

      {hasPending ? (
        <Alert variant="warning">
          <AlertTitle>
            {m.admin_proxies_servers_connection_identity_pending_note_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_identity_pending_note_description()}
          </AlertDescription>
        </Alert>
      ) : null}

      {hasActive ? (
        <Alert variant="info">
          <AlertTitle>
            {m.admin_proxies_servers_connection_identity_active_rotation_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_identity_active_rotation_description()}
          </AlertDescription>
        </Alert>
      ) : null}

      {identities.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4">
          <p className="text-sm font-medium">
            {m.admin_proxies_servers_connection_oauth_empty_title()}
          </p>
          <p className="text-sm text-muted-foreground">
            {m.admin_proxies_servers_connection_oauth_empty_description()}
          </p>
        </div>
      ) : (
        <ul className="divide-y">
          {identities.map((identity) => {
            const revocable =
              identity.status === "pending" || identity.status === "active";
            return (
              <li
                key={identity.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        statusTone[identity.status] ?? ("outline" as const)
                      }
                    >
                      {statusLabel[identity.status]
                        ? statusLabel[identity.status]()
                        : identity.status}
                    </Badge>
                    <span className="text-sm font-medium">
                      {m.admin_proxies_servers_connection_identity_generation({
                        generation: identity.generation,
                      })}
                    </span>
                  </div>
                  <p
                    className="max-w-full truncate font-mono text-xs text-muted-foreground"
                    title={identity.oauthClientId}
                  >
                    {m.admin_proxies_servers_connection_identity_client_id()}:{" "}
                    {identity.oauthClientId}
                  </p>
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {m.admin_proxies_servers_connection_identity_created({
                        date: formatDateTime(identity.createdAt),
                      })}
                    </span>
                    {identity.activatedAt ? (
                      <span>
                        {m.admin_proxies_servers_connection_identity_activated({
                          date: formatDateTime(identity.activatedAt),
                        })}
                      </span>
                    ) : null}
                    {identity.revokedAt ? (
                      <span>
                        {m.admin_proxies_servers_connection_identity_revoked({
                          date: formatDateTime(identity.revokedAt),
                        })}
                      </span>
                    ) : null}
                  </p>
                </div>
                {revocable ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={revoking}
                    onClick={() => onRevoke(identity)}
                  >
                    {m.admin_proxies_servers_connection_identity_revoke()}
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
