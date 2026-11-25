import { KeyRoundIcon, ShieldOffIcon } from "lucide-react";
import type React from "react";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type BackupAction = "enable" | "reset" | "disable";

export interface ServerConnectionBackupProps {
  backupTokenEnabled: boolean;
  /** Whether an OAuth identity currently owns the agent lane. */
  oauthActive: boolean;
  /** Non-secret prefix; null when no static token exists. */
  tokenPrefix: string | null;
  busy: BackupAction | null;
  onEnable: () => void;
  onReset: () => void;
  onDisable: () => void;
}

/**
 * Static bearer credentials are a backup path next to OAuth, not the default.
 * Legacy servers keep their existing token until an administrator explicitly
 * resets or disables it; a disabled backup never touches the OAuth socket.
 */
export function ServerConnectionBackup({
  backupTokenEnabled,
  oauthActive,
  tokenPrefix,
  busy,
  onEnable,
  onReset,
  onDisable,
}: ServerConnectionBackupProps): React.ReactElement {
  const disabled = busy !== null;

  return (
    <section
      data-slot="server-connection-backup"
      className="flex min-w-0 flex-col gap-3 border-t pt-6"
      aria-labelledby="connection-backup-title"
    >
      <SectionHeader>
        <SectionTitle id="connection-backup-title">
          {m.admin_proxies_servers_connection_backup_title()}
        </SectionTitle>
        <Badge variant={backupTokenEnabled ? "warning" : "success"}>
          {backupTokenEnabled
            ? m.admin_proxies_servers_connection_backup_badge_enabled()
            : m.admin_proxies_servers_connection_backup_badge_oauth_only()}
        </Badge>
      </SectionHeader>
      <p className="text-xs text-muted-foreground">
        {backupTokenEnabled
          ? m.admin_proxies_servers_connection_backup_description_enabled()
          : m.admin_proxies_servers_connection_backup_description_oauth_only()}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {m.admin_proxies_servers_connection_backup_prefix_label()}
        </span>
        {tokenPrefix ? (
          <code className="rounded border bg-background px-2 py-1 font-mono text-xs">
            {tokenPrefix}
          </code>
        ) : (
          <span className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_connection_backup_prefix_none()}
          </span>
        )}
      </div>

      {backupTokenEnabled ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          {oauthActive ? (
            <p className="text-xs text-muted-foreground">
              {m.admin_proxies_servers_connection_backup_legacy_note()}
            </p>
          ) : (
            <Alert variant="warning">
              <AlertTitle>
                {m.admin_proxies_servers_connection_backup_only_credential_title()}
              </AlertTitle>
              <AlertDescription>
                {m.admin_proxies_servers_connection_backup_only_credential_description()}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={disabled}
              loading={busy === "reset"}
              onClick={onReset}
            >
              <KeyRoundIcon />
              {m.admin_proxies_servers_connection_backup_reset()}
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={disabled}
              loading={busy === "disable"}
              onClick={onDisable}
            >
              <ShieldOffIcon />
              {m.admin_proxies_servers_connection_backup_disable()}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_connection_backup_reset_description()}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t pt-3">
          <Button
            size="sm"
            className="self-start"
            disabled={disabled}
            loading={busy === "enable"}
            onClick={onEnable}
          >
            <KeyRoundIcon />
            {m.admin_proxies_servers_connection_backup_enable()}
          </Button>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_connection_backup_enable_description()}
          </p>
        </div>
      )}
    </section>
  );
}
