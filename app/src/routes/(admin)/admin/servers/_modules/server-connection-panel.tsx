import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Confirm } from "@/components/ui/confirm";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import {
  currentIdentities,
  enrollmentCreateBlock,
  installationPhase,
} from "@/lib/agent-connection";
import { m } from "@/paraglide/messages";
import {
  AGENT_IDENTITY_QUERY_KEY,
  AGENT_RELEASE_VERSION_QUERY_KEY,
  createServerBootstrapGrant,
  getAgentIdentityState,
  getAgentReleaseVersions,
  revokeAgentEnrollmentGrant,
  revokeAgentIdentityAccess,
} from "@/query/agent-identity";
import {
  disableServerBackupToken,
  enableServerBackupToken,
  resetServerBackupToken,
  SERVERS_QUERY_KEY,
  type ServerDTO,
} from "@/query/servers";

import type {
  ConnectionBootstrapCommand,
  ConnectionGrantRow,
  ConnectionIdentityRow,
} from "./connection-types";
import {
  ServerConnectionBackup,
  type BackupAction,
} from "./server-connection-backup";
import { ServerConnectionGrants } from "./server-connection-grants";
import { ServerConnectionIdentities } from "./server-connection-identities";
import {
  ServerConnectionInstaller,
  type ConnectionInstallerRequest,
} from "./server-connection-installer";
import { ServerConnectionSummary } from "./server-connection-summary";
import { TokenRevealDialog } from "./token-reveal-dialog";
import { useServerList } from "./use-server-list";

export interface ServerConnectionPanelProps {
  server: ServerDTO;
}

/**
 * Connection tab: deployed agent facts, OAuth identity and enrollment state,
 * the one-line bootstrap installer, and the legacy static token moved into a
 * backup area. Generated commands live only in component state.
 */
export function ServerConnectionPanel({
  server,
}: ServerConnectionPanelProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: servers } = useServerList();
  const liveServer = servers?.find((row) => row.id === server.id) ?? server;
  const identityQueryKey = [...AGENT_IDENTITY_QUERY_KEY, server.id];
  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState<ConnectionBootstrapCommand | null>(
    null,
  );

  const identityQuery = useQuery({
    queryKey: identityQueryKey,
    queryFn: () => getAgentIdentityState({ data: { serverId: server.id } }),
    refetchInterval: 15_000,
  });
  const versionsQuery = useQuery({
    queryKey: AGENT_RELEASE_VERSION_QUERY_KEY,
    queryFn: () => getAgentReleaseVersions(),
    staleTime: 5 * 60_000,
  });

  const invalidateIdentity = () =>
    queryClient.invalidateQueries({ queryKey: identityQueryKey });

  const createGrant = useMutation({
    mutationFn: (input: {
      mode: "enroll" | "replace";
      release: string;
      migrateFromStaticToken: boolean;
    }) =>
      createServerBootstrapGrant({
        data: {
          serverId: server.id,
          mode: input.mode,
          confirmReplace: input.mode === "replace" ? true : undefined,
          release: input.release,
          migrateFromStaticToken: input.migrateFromStaticToken,
        },
      }),
  });

  const revokeGrant = useMutation({
    mutationFn: (grantId: string) =>
      revokeAgentEnrollmentGrant({ data: { grantId } }),
    onSuccess: async () => {
      await invalidateIdentity();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_connection_toast_grant_revoked(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_revoke_failed(),
      });
    },
  });

  const revokeIdentity = useMutation({
    mutationFn: (identityId: string) =>
      revokeAgentIdentityAccess({ data: { identityId } }),
    onSuccess: async () => {
      await invalidateIdentity();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_connection_toast_identity_revoked(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_revoke_failed(),
      });
    },
  });

  const invalidateServers = () =>
    queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY });

  const enableBackup = useMutation({
    mutationFn: () => enableServerBackupToken({ data: { id: server.id } }),
    onSuccess: async () => {
      await invalidateServers();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_connection_toast_backup_enabled(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_backup_failed(),
      });
    },
  });

  const resetToken = useMutation({
    mutationFn: () => resetServerBackupToken({ data: { id: server.id } }),
    onSuccess: async () => {
      await invalidateServers();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_toast_token_reset(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_backup_failed(),
      });
    },
  });

  const disableBackup = useMutation({
    mutationFn: () => disableServerBackupToken({ data: { id: server.id } }),
    onSuccess: async () => {
      await invalidateServers();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_connection_toast_backup_disabled(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_backup_failed(),
      });
    },
  });

  const requestCreate = async (request: ConnectionInstallerRequest) => {
    const minutes = versionsQuery.data?.grantLifetimeMinutes ?? 15;
    const activeGeneration =
      currentIdentities(identityQuery.data?.identities ?? []).active
        ?.generation ?? null;
    if (request.mode === "replace" && activeGeneration !== null) {
      const ok = await Confirm.call({
        title:
          m.admin_proxies_servers_connection_installer_replace_confirm_title(),
        description:
          m.admin_proxies_servers_connection_installer_replace_confirm_description(
            { minutes, generation: activeGeneration },
          ),
        confirmLabel:
          m.admin_proxies_servers_connection_installer_generate_replace(),
        cancelLabel: m.admin_proxies_servers_form_cancel(),
      });
      if (!ok) {
        return;
      }
    }

    setCreating(true);
    try {
      const result = await createGrant.mutateAsync({
        mode: request.mode,
        release: request.release,
        migrateFromStaticToken: request.migrateFromStaticToken,
      });
      createGrant.reset();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_connection_toast_grant_created(),
      });
      setCommand({
        expiresAt: result.grant.expiresAt,
        dockerCommand: result.dockerCommand,
        hostCommand: result.hostCommand,
      });
      void invalidateIdentity();
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_create_failed(),
      });
    } finally {
      setCreating(false);
    }
  };

  const requestRevokeGrant = async (grant: ConnectionGrantRow) => {
    await Confirm.call({
      title: m.admin_proxies_servers_connection_grant_revoke_confirm_title(),
      description:
        m.admin_proxies_servers_connection_grant_revoke_confirm_description(),
      confirmLabel: m.admin_proxies_servers_connection_grant_revoke(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
      onConfirm: () => revokeGrant.mutateAsync(grant.id),
    });
  };

  const requestRevokeIdentity = async (identity: ConnectionIdentityRow) => {
    await Confirm.call({
      title: m.admin_proxies_servers_connection_identity_revoke_confirm_title(),
      description:
        m.admin_proxies_servers_connection_identity_revoke_confirm_description(),
      confirmLabel: m.admin_proxies_servers_connection_identity_revoke(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
      onConfirm: () => revokeIdentity.mutateAsync(identity.id),
    });
  };

  const requestEnableBackup = async () => {
    let token: string | undefined;
    await Confirm.call({
      title: m.admin_proxies_servers_connection_backup_enable_confirm_title(),
      description:
        m.admin_proxies_servers_connection_backup_enable_confirm_description(),
      confirmLabel: m.admin_proxies_servers_connection_backup_enable(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      onConfirm: async () => {
        const result = await enableBackup.mutateAsync();
        token = result.token;
      },
    });
    if (token) {
      await TokenRevealDialog.call({ token });
      enableBackup.reset();
    }
  };

  const requestResetBackup = async () => {
    let token: string | undefined;
    await Confirm.call({
      title: m.admin_proxies_servers_connection_backup_reset_confirm_title(),
      description:
        m.admin_proxies_servers_connection_backup_reset_confirm_description(),
      confirmLabel: m.admin_proxies_servers_connection_backup_reset(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
      onConfirm: async () => {
        const result = await resetToken.mutateAsync();
        token = result.token;
      },
    });
    if (token) {
      await TokenRevealDialog.call({ token });
      resetToken.reset();
    }
  };

  const requestDisableBackup = async () => {
    await Confirm.call({
      title: m.admin_proxies_servers_connection_backup_disable_confirm_title(),
      description:
        m.admin_proxies_servers_connection_backup_disable_confirm_description(),
      confirmLabel: m.admin_proxies_servers_connection_backup_disable(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
      onConfirm: () => disableBackup.mutateAsync(),
    });
  };

  const connection = identityQuery.data;
  const { active: activeIdentity } = currentIdentities(
    connection?.identities ?? [],
  );
  const replacementMode = activeIdentity ? "replace" : "enroll";
  const phase = connection
    ? installationPhase({
        identities: connection.identities,
        grants: connection.grants,
      })
    : null;
  const block =
    connection && phase
      ? enrollmentCreateBlock({
          serverEnabled: liveServer.enabled,
          identities: connection.identities,
        })
      : null;
  const backupBusy: BackupAction | null = enableBackup.isPending
    ? "enable"
    : resetToken.isPending
      ? "reset"
      : disableBackup.isPending
        ? "disable"
        : null;

  return (
    <div data-slot="server-connection" className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium">
          {m.admin_proxies_servers_connection_title()}
        </h2>
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_description()}
        </p>
      </div>

      {identityQuery.isPending ? (
        <section className="flex items-center gap-2 rounded-xl border bg-card p-4 text-sm text-muted-foreground shadow-xs">
          <Spinner />
          {m.admin_proxies_servers_connection_loading()}
        </section>
      ) : identityQuery.isError && !connection ? (
        <Alert variant="error">
          <AlertTitle>
            {m.admin_proxies_servers_connection_error_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_error_description()}
          </AlertDescription>
        </Alert>
      ) : connection && phase ? (
        <>
          <ServerConnectionSummary server={liveServer} phase={phase} />
          <ServerConnectionIdentities
            identities={connection.identities}
            revoking={revokeIdentity.isPending}
            onRevoke={(identity) => void requestRevokeIdentity(identity)}
          />
          <ServerConnectionInstaller
            versions={versionsQuery.data?.versions}
            versionsPending={versionsQuery.isPending}
            versionsError={versionsQuery.isError && !versionsQuery.data}
            block={block}
            phase={phase}
            mode={replacementMode}
            activeGeneration={activeIdentity?.generation ?? null}
            backupTokenEnabled={liveServer.backupTokenEnabled}
            lifetimeMinutes={versionsQuery.data?.grantLifetimeMinutes ?? 15}
            creating={creating}
            command={command}
            onCreate={(request) => void requestCreate(request)}
            onClear={() => setCommand(null)}
          />
          <ServerConnectionGrants
            grants={connection.grants}
            activeGeneration={activeIdentity?.generation ?? null}
            revoking={revokeGrant.isPending}
            onRevoke={(grant) => void requestRevokeGrant(grant)}
          />
        </>
      ) : null}

      <ServerConnectionBackup
        backupTokenEnabled={liveServer.backupTokenEnabled}
        oauthActive={activeIdentity !== null}
        tokenPrefix={liveServer.agentTokenPrefix}
        busy={backupBusy}
        onEnable={() => void requestEnableBackup()}
        onReset={() => void requestResetBackup()}
        onDisable={() => void requestDisableBackup()}
      />
    </div>
  );
}
