import type React from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import type { DeployRuntime } from "@/lib/runtime-info";
import { m } from "@/paraglide/messages";
import type { SystemStatus } from "@/query/settings";

const RUNTIME_LABELS: Record<DeployRuntime, () => string> = {
  cloudflare: () => m.admin_settings_status_runtime_cloudflare(),
  vercel: () => m.admin_settings_status_runtime_vercel(),
  netlify: () => m.admin_settings_status_runtime_netlify(),
  node: () => m.admin_settings_status_runtime_node(),
  unknown: () => m.admin_settings_status_runtime_unknown(),
};

function ConfiguredBadge({
  configured,
}: {
  configured: boolean;
}): React.ReactElement {
  return configured ? (
    <Badge variant="success">{m.admin_settings_status_configured()}</Badge>
  ) : (
    <Badge variant="secondary">
      {m.admin_settings_status_not_configured()}
    </Badge>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/**
 * Read-only facts about the deployment. Only names, URLs and "configured or
 * not" flags: the server never sends keys or secrets for this card.
 */
export function SystemStatusCard({
  status,
}: {
  status: SystemStatus;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.admin_settings_status_title()}</CardTitle>
        <CardDescription>
          {m.admin_settings_status_description()}
        </CardDescription>
      </CardHeader>
      <CardPanel>
        <dl className="divide-y">
          <Row label={m.admin_settings_status_app_name()}>{status.appName}</Row>
          <Row label={m.admin_settings_status_auth_url()}>
            <span className="font-mono text-xs">{status.authUrl}</span>
          </Row>
          <Row label={m.admin_settings_status_email()}>
            <ConfiguredBadge configured={status.emailConfigured} />
          </Row>
          <Row label="GitHub">
            <ConfiguredBadge configured={status.socialProviders.github} />
          </Row>
          <Row label="Google">
            <ConfiguredBadge configured={status.socialProviders.google} />
          </Row>
          <Row label={m.admin_settings_status_runtime()}>
            {RUNTIME_LABELS[status.runtime]()}
          </Row>
          <Row label={m.admin_settings_status_database()}>
            <span className="font-mono text-xs">{status.databaseDriver}</span>
          </Row>
        </dl>
      </CardPanel>
    </Card>
  );
}
