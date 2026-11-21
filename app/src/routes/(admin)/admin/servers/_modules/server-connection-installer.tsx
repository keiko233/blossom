import { FileCodeIcon, FileDownIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type {
  EnrollmentCreateBlock,
  InstallationPhase,
} from "@/lib/agent-connection";
import { m } from "@/paraglide/messages";

import type { ConnectionReleaseOption } from "./connection-types";

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
  release: string;
  capabilities: string[];
}

export interface ServerConnectionInstallerProps {
  releases: readonly ConnectionReleaseOption[] | undefined;
  optionsPending: boolean;
  optionsError: boolean;
  requiredCapabilities: readonly string[];
  block: EnrollmentCreateBlock;
  phase: InstallationPhase;
  mode: "enroll" | "replace";
  /** Active generation that stays connected until a replacement proves. */
  activeGeneration: number | null;
  lifetimeMinutes: number;
  creating: "stdin" | "inline" | null;
  onCreate: (
    delivery: "stdin" | "inline",
    request: ConnectionInstallerRequest,
  ) => void;
}

/**
 * Release-gated installer controls. Creating a grant or downloading its script
 * is not installation success; the identity and heartbeat sections show the
 * deployed state.
 */
export function ServerConnectionInstaller({
  releases,
  optionsPending,
  optionsError,
  requiredCapabilities,
  block,
  phase,
  mode,
  activeGeneration,
  lifetimeMinutes,
  creating,
  onCreate,
}: ServerConnectionInstallerProps): React.ReactElement {
  const [requestedVersion, setRequestedVersion] = useState("");
  const [ptyEnabled, setPtyEnabled] = useState(false);

  const compatibleReleases =
    releases?.filter((release) => release.compatible) ?? [];
  const selectedRelease =
    compatibleReleases.find(
      (release) => release.version === requestedVersion,
    ) ?? compatibleReleases[0];
  const ptySupported =
    selectedRelease?.capabilities.includes("pty-v1") ?? false;
  const effectivePty = ptyEnabled && ptySupported;

  const create = (delivery: "stdin" | "inline") => {
    if (!selectedRelease) {
      return;
    }
    onCreate(delivery, {
      mode,
      release: selectedRelease.version,
      capabilities: effectivePty ? ["pty-v1"] : [],
    });
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

      {optionsPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {m.admin_proxies_servers_connection_installer_loading()}
        </div>
      ) : optionsError ? (
        <Alert variant="error">
          <AlertTitle>
            {m.admin_proxies_servers_connection_installer_options_error_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_installer_options_error_description()}
          </AlertDescription>
        </Alert>
      ) : releases && releases.length === 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {m.admin_proxies_servers_connection_installer_no_release_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_installer_no_release_description()}
          </AlertDescription>
        </Alert>
      ) : compatibleReleases.length === 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {m.admin_proxies_servers_connection_installer_no_compatible_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_proxies_servers_connection_installer_no_compatible_description(
              {
                capabilities: requiredCapabilities.join(", "),
              },
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {m.admin_proxies_servers_connection_installer_release_label()}
              </span>
              <Select
                items={compatibleReleases.map((release) => ({
                  label:
                    m.admin_proxies_servers_connection_installer_release_option(
                      {
                        version: release.version,
                        singBox: release.singBoxVersion,
                      },
                    ),
                  value: release.version,
                }))}
                value={selectedRelease?.version ?? ""}
                onValueChange={(next) => setRequestedVersion(String(next))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {compatibleReleases.map((release) => (
                    <SelectItem key={release.version} value={release.version}>
                      {m.admin_proxies_servers_connection_installer_release_option(
                        {
                          version: release.version,
                          singBox: release.singBoxVersion,
                        },
                      )}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={effectivePty}
                  disabled={!ptySupported || creating !== null}
                  onCheckedChange={(checked) => setPtyEnabled(checked)}
                />
                <span>
                  {m.admin_proxies_servers_connection_installer_pty_label()}
                </span>
              </label>
              <p className="text-xs text-muted-foreground">
                {ptySupported
                  ? m.admin_proxies_servers_connection_installer_pty_description()
                  : m.admin_proxies_servers_connection_installer_pty_unavailable()}
              </p>
            </div>
          </div>

          {releases && releases.length > compatibleReleases.length ? (
            <p className="text-xs text-muted-foreground">
              {m.admin_proxies_servers_connection_installer_incompatible_note()}
            </p>
          ) : null}
        </>
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

      {releases && compatibleReleases.length > 0 ? (
        <>
          {mode === "replace" && activeGeneration !== null ? (
            <Alert variant="info">
              <AlertTitle>
                {m.admin_proxies_servers_connection_installer_replace_title()}
              </AlertTitle>
              <AlertDescription>
                {m.admin_proxies_servers_connection_installer_replace_description(
                  { generation: activeGeneration },
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={block !== null || creating !== null}
              loading={creating === "stdin"}
              onClick={() => create("stdin")}
            >
              <FileDownIcon />
              {mode === "replace"
                ? m.admin_proxies_servers_connection_installer_create_replace()
                : m.admin_proxies_servers_connection_installer_create_grant()}
            </Button>
            <Button
              variant="outline"
              disabled={block !== null || creating !== null}
              loading={creating === "inline"}
              onClick={() => create("inline")}
            >
              <FileCodeIcon />
              {mode === "replace"
                ? m.admin_proxies_servers_connection_installer_create_replace_inline()
                : m.admin_proxies_servers_connection_installer_create_inline()}
            </Button>
          </div>
          <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <p>
              {mode === "replace"
                ? m.admin_proxies_servers_connection_installer_create_replace_description()
                : m.admin_proxies_servers_connection_installer_create_grant_description()}
            </p>
            <p>
              {mode === "replace"
                ? m.admin_proxies_servers_connection_installer_create_replace_inline_description()
                : m.admin_proxies_servers_connection_installer_create_inline_description()}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_connection_installer_expiry_note({
              minutes: lifetimeMinutes,
            })}
          </p>
        </>
      ) : null}
    </section>
  );
}
