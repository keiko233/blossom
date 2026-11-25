import { useMutation } from "@tanstack/react-query";
import type React from "react";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { checkServerUpdate, type ServerDTO } from "@/query/servers";

import { updateStateLabel } from "./server-status";

const updateLabel = {
  requested: m.server_live_update_requested,
  polling: m.server_live_update_polling,
  unmanaged: m.server_live_update_unmanaged,
};

export interface ServerVersionsSectionProps {
  server: ServerDTO;
}

/**
 * Version and managed-update state for one server. The update-check buttons
 * live here now that the live stream is a separate tab.
 */
export function ServerVersionsSection({
  server,
}: ServerVersionsSectionProps): React.ReactElement {
  const update = useMutation({
    mutationFn: (target: "agent" | "sing-box") =>
      checkServerUpdate({ data: { id: server.id, target } }),
  });

  const result = update.isError
    ? m.server_live_update_failed()
    : update.data
      ? updateLabel[update.data]()
      : null;

  return (
    <section
      data-slot="server-versions"
      className="flex flex-col gap-3 border-t pt-6"
      aria-labelledby="server-versions-title"
    >
      <SectionHeader>
        <SectionTitle id="server-versions-title">
          {m.admin_proxies_servers_col_version()}
        </SectionTitle>
      </SectionHeader>

      <div className="flex flex-col gap-3 text-sm">
        <VersionRow
          label={m.admin_proxies_servers_versions_agent()}
          version={server.agentVersion}
          desired={server.desiredAgentVersion}
          state={server.agentUpdateState}
          error={server.agentUpdateError}
          busy={update.isPending}
          disabled={!server.enabled}
          onCheck={() => update.mutate("agent")}
          checkLabel={m.server_live_update_agent()}
        />
        <VersionRow
          label={m.admin_proxies_servers_versions_sing_box()}
          version={server.singBoxVersion}
          desired={server.desiredSingBoxVersion}
          state={server.singBoxUpdateState}
          error={server.singBoxUpdateError}
          busy={update.isPending}
          disabled={!server.enabled}
          onCheck={() => update.mutate("sing-box")}
          checkLabel={m.server_live_update_singbox()}
        />
      </div>
      {result ? (
        <p role="status" className="text-xs text-muted-foreground">
          {result}
        </p>
      ) : null}
    </section>
  );
}

interface VersionRowProps {
  label: string;
  version: string | null;
  desired: string | null;
  state: string;
  error: string | null;
  busy: boolean;
  disabled: boolean;
  checkLabel: string;
  onCheck: () => void;
}

function VersionRow({
  label,
  version,
  desired,
  state,
  error,
  busy,
  disabled,
  checkLabel,
  onCheck,
}: VersionRowProps): React.ReactElement {
  const stateText = updateStateLabel(state);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button
          size="xs"
          variant="outline"
          loading={busy}
          disabled={disabled}
          onClick={onCheck}
        >
          {checkLabel}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono">{version ? `v${version}` : "—"}</span>
        {desired ? (
          <span className="font-mono text-muted-foreground">→ {desired}</span>
        ) : null}
        {stateText ? (
          <Badge variant="outline" title={error ?? undefined}>
            {stateText}
          </Badge>
        ) : null}
      </div>
      {state === "failed" && error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
