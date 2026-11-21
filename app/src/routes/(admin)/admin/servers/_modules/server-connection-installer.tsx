import { CheckIcon, CopyIcon, SparklesIcon, XIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import type {
  EnrollmentCreateBlock,
  InstallationPhase,
} from "@/lib/agent-connection";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

import type {
  ConnectionBootstrapCommand,
  ConnectionReleaseVersionOption,
} from "./connection-types";

const blockTitle: Record<Exclude<EnrollmentCreateBlock, null>, () => string> = {
  server_disabled:
    m.admin_proxies_servers_connection_installer_block_server_disabled_title,
  pending_identity:
    m.admin_proxies_servers_connection_installer_block_pending_title,
};

const blockDescription: Record<
  Exclude<EnrollmentCreateBlock, null>,
  () => string
> = {
  server_disabled:
    m.admin_proxies_servers_connection_installer_block_server_disabled_description,
  pending_identity:
    m.admin_proxies_servers_connection_installer_block_pending_description,
};

export interface ConnectionInstallerRequest {
  mode: "enroll" | "replace";
  /** `latest` or a bare version such as `1.5.0`. */
  release: string;
}

export interface ServerConnectionInstallerProps {
  versions: readonly ConnectionReleaseVersionOption[] | undefined;
  versionsPending: boolean;
  versionsError: boolean;
  block: EnrollmentCreateBlock;
  phase: InstallationPhase;
  mode: "enroll" | "replace";
  /** Active generation that stays connected until a replacement proves. */
  activeGeneration: number | null;
  lifetimeMinutes: number;
  creating: boolean;
  /** Commands generated in this session; cleared or replaced on request. */
  command: ConnectionBootstrapCommand | null;
  onCreate: (request: ConnectionInstallerRequest) => void;
  onClear: () => void;
}

interface CommandCardProps {
  title: string;
  description: string;
  command: string;
}

/** One copyable command. The text is a credential; it is never logged. */
function CommandCard({
  title,
  description,
  command,
}: CommandCardProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_onboarding_copied(),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_onboarding_copy_failed(),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/32 p-3">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-card p-3 font-mono text-xs">
          {command}
        </pre>
        <Button
          variant="outline"
          size="icon"
          aria-label={m.admin_proxies_servers_onboarding_copy()}
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

function versionLabel(version: ConnectionReleaseVersionOption): string {
  return version.value === "latest"
    ? m.admin_proxies_servers_connection_installer_version_latest()
    : version.prerelease
      ? m.admin_proxies_servers_connection_installer_version_prerelease({
          version: version.value,
        })
      : m.admin_proxies_servers_connection_installer_version({
          version: version.value,
        });
}

/**
 * One-line bootstrap installer controls. A generated command is a one-time
 * credential, not installation success; the identity and heartbeat sections
 * show the deployed state. Works for a host that has never enrolled and for
 * one that already runs the agent.
 */
export function ServerConnectionInstaller({
  versions,
  versionsPending,
  versionsError,
  block,
  phase,
  mode,
  activeGeneration,
  lifetimeMinutes,
  creating,
  command,
  onCreate,
  onClear,
}: ServerConnectionInstallerProps): React.ReactElement {
  const [requestedVersion, setRequestedVersion] = useState("latest");

  const selectedVersion =
    versions?.find((version) => version.value === requestedVersion) ??
    versions?.[0];
  const expires = command ? formatDateTime(command.expiresAt) : null;

  const create = () => {
    if (block !== null || creating) {
      return;
    }
    onCreate({ mode, release: selectedVersion?.value ?? "latest" });
  };

  return (
    <section
      data-slot="server-connection-installer"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div>
        <h2 className="font-medium">
          {m.admin_proxies_servers_connection_installer_title()}
        </h2>
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_installer_description()}
        </p>
      </div>

      {versionsPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {m.admin_proxies_servers_connection_installer_version_loading()}
        </div>
      ) : versionsError ? (
        <Alert variant="error">
          <AlertTitle>
            {m.admin_proxies_servers_connection_installer_versions_error_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_installer_versions_error_description()}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            {m.admin_proxies_servers_connection_installer_version_label()}
          </span>
          <Select
            items={(versions ?? []).map((version) => ({
              label: versionLabel(version),
              value: version.value,
            }))}
            value={selectedVersion?.value ?? "latest"}
            onValueChange={(next) => setRequestedVersion(String(next))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {(versions ?? []).map((version) => (
                <SelectItem key={version.value} value={version.value}>
                  {versionLabel(version)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}

      {block ? (
        <Alert variant="warning">
          <AlertTitle>{blockTitle[block]()}</AlertTitle>
          <AlertDescription>{blockDescription[block]()}</AlertDescription>
        </Alert>
      ) : null}

      {phase === "pending_activation" ? (
        <p className="text-xs text-muted-foreground">
          {m.admin_proxies_servers_connection_installer_pending_phase_note()}
        </p>
      ) : null}

      {mode === "replace" && activeGeneration !== null ? (
        <Alert variant="info">
          <AlertTitle>
            {m.admin_proxies_servers_connection_installer_replace_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_installer_replace_description({
              generation: activeGeneration,
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={block !== null || creating || !versions}
          loading={creating}
          onClick={create}
        >
          <SparklesIcon />
          {command
            ? m.admin_proxies_servers_connection_installer_regenerate()
            : mode === "replace"
              ? m.admin_proxies_servers_connection_installer_generate_replace()
              : m.admin_proxies_servers_connection_installer_generate()}
        </Button>
        {command ? (
          <Button variant="outline" disabled={creating} onClick={onClear}>
            <XIcon />
            {m.admin_proxies_servers_connection_installer_command_clear()}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {m.admin_proxies_servers_connection_installer_expiry_note({
          minutes: lifetimeMinutes,
        })}
      </p>

      {command ? (
        <>
          <Alert variant="warning">
            <AlertTitle>
              {m.admin_proxies_servers_connection_installer_command_warning_title()}
            </AlertTitle>
            <AlertDescription>
              {m.admin_proxies_servers_connection_installer_command_warning_description()}
            </AlertDescription>
          </Alert>
          {expires ? (
            <p className="text-xs text-muted-foreground">
              {m.admin_proxies_servers_connection_installer_command_expires({
                date: expires,
              })}
            </p>
          ) : null}
          <CommandCard
            title={m.admin_proxies_servers_onboarding_docker_title()}
            description={m.admin_proxies_servers_onboarding_docker_description()}
            command={command.dockerCommand}
          />
          <CommandCard
            title={m.admin_proxies_servers_onboarding_host_title()}
            description={m.admin_proxies_servers_onboarding_host_description()}
            command={command.hostCommand}
          />
        </>
      ) : null}
    </section>
  );
}
