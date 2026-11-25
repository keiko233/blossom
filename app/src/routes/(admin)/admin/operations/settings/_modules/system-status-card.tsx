import type React from "react";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import type { EmailProvider } from "@/lib/email-config";
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

const EMAIL_PROVIDER_LABELS: Record<EmailProvider, () => string> = {
  resend: () => m.admin_settings_status_email_provider_resend(),
  smtp: () => m.admin_settings_status_email_provider_smtp(),
  cloudflare: () => m.admin_settings_status_email_provider_cloudflare(),
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
    <section
      id="settings-status"
      className="flex scroll-mt-(--page-header-h) flex-col gap-4 border-b pb-6"
    >
      <SectionHeader>
        <div className="flex min-w-0 flex-col gap-0.5">
          <SectionTitle>{m.admin_settings_status_title()}</SectionTitle>
          <span className="text-xs text-muted-foreground">
            {m.admin_settings_status_description()}
          </span>
        </div>
      </SectionHeader>
      <div>
        <dl className="divide-y">
          <Row label={m.admin_settings_status_app_name()}>{status.appName}</Row>
          <Row label={m.admin_settings_status_auth_url()}>
            <span className="font-mono text-xs">{status.authUrl}</span>
          </Row>
          <Row label={m.admin_settings_status_email()}>
            {status.emailProvider ? (
              EMAIL_PROVIDER_LABELS[status.emailProvider]()
            ) : (
              <ConfiguredBadge configured={false} />
            )}
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
      </div>
    </section>
  );
}
