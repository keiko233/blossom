import { KeyRoundIcon } from "lucide-react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";

export interface ServerConnectionBackupProps {
  tokenPrefix: string;
  resetting: boolean;
  onResetToken: () => void;
}

/**
 * Static token controls stay in a clearly marked backup area. The existing
 * reset action and one-time reveal are unchanged so legacy agents keep their
 * current admin flow; OAuth-only mode needs a separate backend.
 */
export function ServerConnectionBackup({
  tokenPrefix,
  resetting,
  onResetToken,
}: ServerConnectionBackupProps): React.ReactElement {
  return (
    <section
      data-slot="server-connection-backup"
      className="flex flex-col gap-4 rounded-xl border bg-muted/24 p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">
          {m.admin_proxies_servers_connection_backup_title()}
        </h2>
        <Badge variant="warning">
          {m.admin_proxies_servers_connection_backup_badge()}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {m.admin_proxies_servers_connection_backup_description()}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {m.admin_proxies_servers_connection_backup_prefix_label()}
        </span>
        <code className="rounded border bg-background px-2 py-1 font-mono text-xs">
          {tokenPrefix}
        </code>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-3">
        <div className="flex max-w-xl flex-col gap-1">
          <label
            className="flex items-center gap-2 text-sm font-medium"
            htmlFor="oauth-only-mode"
          >
            {m.admin_proxies_servers_connection_backup_mode_label()}
            <Badge variant="outline">
              {m.admin_proxies_servers_connection_backup_mode_unavailable()}
            </Badge>
          </label>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_connection_backup_mode_description()}
          </p>
        </div>
        {/* The OAuth-only mode switch requires a separate backend; keep the
            mutation visibly unavailable rather than pretending it succeeded. */}
        <Switch
          id="oauth-only-mode"
          checked={false}
          disabled
          aria-label={m.admin_proxies_servers_connection_backup_mode_label()}
        />
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="destructive-outline"
          className="self-start"
          loading={resetting}
          onClick={() => onResetToken()}
        >
          <KeyRoundIcon />
          {m.admin_proxies_servers_connection_backup_reset()}
        </Button>
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_backup_reset_description()}
        </p>
      </div>
    </section>
  );
}
