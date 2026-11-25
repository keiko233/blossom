import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, CopyIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { WorkspaceViewport } from "@/components/app-shell/workspace";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import {
  AGENT_ONBOARDING_GRANT_QUERY_KEY,
  AGENT_RELEASE_VERSION_QUERY_KEY,
  createAgentOnboardingGrant,
  getAgentReleaseVersions,
  getOnboardingGrantStatus,
} from "@/query/agent-identity";

const SERVERS_LIST = "/admin/servers" as const;

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
    <section
      data-slot="server-onboarding-command"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">
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
    </section>
  );
}

function connectionLabel(server: {
  lastSeenAt: Date | string | null;
  wsConnectedAt: Date | string | null;
}): string {
  if (server.wsConnectedAt || server.lastSeenAt) {
    return m.admin_proxies_servers_onboarding_connected();
  }
  return m.admin_proxies_servers_onboarding_waiting_connection();
}

/**
 * "Add a server" onboarding. No server row exists until the generated
 * command runs and redeems its one-time grant, so abandoning the page leaves
 * nothing half-configured behind.
 */
export function ServerOnboardingPage(): React.ReactElement {
  const [requestedVersion, setRequestedVersion] = useState("latest");

  const versionsQuery = useQuery({
    queryKey: AGENT_RELEASE_VERSION_QUERY_KEY,
    queryFn: () => getAgentReleaseVersions(),
    staleTime: 5 * 60_000,
  });

  const createGrant = useMutation({
    mutationFn: () =>
      createAgentOnboardingGrant({ data: { release: requestedVersion } }),
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_onboarding_create_error(),
      });
    },
  });

  const grant = createGrant.data;
  const statusQuery = useQuery({
    queryKey: [...AGENT_ONBOARDING_GRANT_QUERY_KEY, grant?.grantId],
    queryFn: () =>
      getOnboardingGrantStatus({ data: { grantId: grant?.grantId ?? "" } }),
    enabled: Boolean(grant?.grantId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "issued" || status === "redeeming" ? 3_000 : false;
    },
  });

  const versions = versionsQuery.data?.versions ?? [
    { value: "latest", tag: null, prerelease: false },
  ];
  const selectedVersion =
    versions.find((version) => version.value === requestedVersion) ??
    versions[0];
  const status = statusQuery.data;
  const createdServerId = status?.server?.id ?? null;

  const versionLabel = (version: (typeof versions)[number]) =>
    version.value === "latest"
      ? m.admin_proxies_servers_onboarding_version_latest()
      : version.prerelease
        ? m.admin_proxies_servers_onboarding_version_prerelease({
            version: version.value,
          })
        : m.admin_proxies_servers_onboarding_version({
            version: version.value,
          });

  return (
    <WorkspaceViewport scrollId="server-new">
      <PageHeader>
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.admin_proxies_servers_form_back()}
            render={<Link to={SERVERS_LIST} />}
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>
            {m.admin_proxies_servers_form_create_title()}
          </PageHeaderTitle>
        </div>
        <PageHeaderActions>
          <Button variant="ghost" render={<Link to={SERVERS_LIST} />}>
            {m.admin_proxies_servers_form_cancel()}
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <PageContent width="form">
        <p className="text-sm text-muted-foreground">
          {m.admin_proxies_servers_onboarding_description()}
        </p>

        <section
          data-slot="server-onboarding-generate"
          className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {m.admin_proxies_servers_onboarding_version_label()}
              </span>
              <Select
                items={versions.map((version) => ({
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
                  {versions.map((version) => (
                    <SelectItem key={version.value} value={version.value}>
                      {versionLabel(version)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {versionsQuery.isPending ? (
                <span
                  className="flex flex-col gap-1.5"
                  role="status"
                  aria-busy="true"
                >
                  <span className="sr-only">
                    {m.admin_proxies_servers_onboarding_version_loading()}
                  </span>
                  <Skeleton className="h-3 w-32" />
                </span>
              ) : null}
            </div>
            <div className="flex flex-col justify-end">
              <Button
                loading={createGrant.isPending}
                onClick={() => createGrant.mutate()}
              >
                {grant
                  ? m.admin_proxies_servers_onboarding_regenerate()
                  : m.admin_proxies_servers_onboarding_generate()}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {m.admin_proxies_servers_onboarding_grants_note({
              minutes: versionsQuery.data?.grantLifetimeMinutes ?? 15,
            })}
          </p>
        </section>

        {grant ? (
          <>
            <Alert variant="warning">
              <AlertTitle>
                {m.admin_proxies_servers_onboarding_secret_title()}
              </AlertTitle>
              <AlertDescription>
                {m.admin_proxies_servers_onboarding_secret_description()}
              </AlertDescription>
            </Alert>

            <CommandCard
              key={`docker-${grant.grantId}`}
              title={m.admin_proxies_servers_onboarding_docker_title()}
              description={m.admin_proxies_servers_onboarding_docker_description()}
              command={grant.dockerCommand}
            />
            <CommandCard
              key={`host-${grant.grantId}`}
              title={m.admin_proxies_servers_onboarding_host_title()}
              description={m.admin_proxies_servers_onboarding_host_description()}
              command={grant.hostCommand}
            />

            <section
              data-slot="server-onboarding-status"
              className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs"
            >
              <h2 className="font-medium">
                {m.admin_proxies_servers_onboarding_status_title()}
              </h2>
              {statusQuery.isPending ? (
                <div
                  className="flex flex-col gap-2"
                  role="status"
                  aria-busy="true"
                >
                  <span className="sr-only">
                    {m.admin_proxies_servers_onboarding_status_loading()}
                  </span>
                  <Skeleton className="h-4 w-56" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ) : status ? (
                <>
                  <p className="text-sm">
                    {status.status === "issued"
                      ? m.admin_proxies_servers_onboarding_status_waiting()
                      : status.status === "redeeming"
                        ? m.admin_proxies_servers_onboarding_status_redeeming()
                        : status.status === "redeemed"
                          ? m.admin_proxies_servers_onboarding_status_redeemed()
                          : status.status === "expired"
                            ? m.admin_proxies_servers_onboarding_status_expired()
                            : m.admin_proxies_servers_onboarding_status_revoked()}
                  </p>
                  {status.server ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {m.admin_proxies_servers_onboarding_server({
                          name: status.server.name ?? status.server.id,
                          state: connectionLabel(status.server),
                        })}
                      </p>
                      {createdServerId ? (
                        <div>
                          <Button
                            render={
                              <Link
                                to="/admin/servers/$serverId"
                                params={{ serverId: createdServerId }}
                              />
                            }
                          >
                            {m.admin_proxies_servers_onboarding_open_server()}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {m.admin_proxies_servers_onboarding_status_waiting()}
                </p>
              )}
            </section>
          </>
        ) : null}
      </PageContent>
    </WorkspaceViewport>
  );
}
