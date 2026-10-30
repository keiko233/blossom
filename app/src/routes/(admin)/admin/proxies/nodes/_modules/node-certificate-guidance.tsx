import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isDeploymentWaitingOnAgent,
  type NodeCertificateDeployment,
  type NodeCertificateUsage,
} from "@/lib/node-certificate-context";
import { m } from "@/paraglide/messages";

const CERTIFICATES = "/admin/proxies/certificates" as const;

const linkClass = "underline underline-offset-4 hover:text-foreground";

function deploymentBadge(
  deployment: NodeCertificateDeployment,
): { label: string; variant: "default" | "destructive" | "outline" } | null {
  switch (deployment.kind) {
    case "pending":
      return {
        label: m.admin_certificates_deploy_pending(),
        variant: "outline",
      };
    case "installed":
      return {
        label: m.admin_certificates_deploy_installed(),
        variant: "outline",
      };
    case "in_use":
      return {
        label: m.admin_certificates_deploy_in_use(),
        variant: "default",
      };
    case "error":
      return {
        label: m.admin_certificates_deploy_error(),
        variant: "destructive",
      };
    default:
      return null;
  }
}

function deploymentExplanation(
  deployment: NodeCertificateDeployment,
): string | null {
  switch (deployment.kind) {
    case "on_save":
      return m.admin_proxies_nodes_cert_deploy_on_save();
    case "unreported":
      return m.admin_proxies_nodes_cert_deploy_unreported();
    case "pending":
      return isDeploymentWaitingOnAgent(deployment)
        ? m.admin_proxies_nodes_cert_deploy_pending_stale()
        : m.admin_proxies_nodes_cert_deploy_pending();
    case "installed":
      return m.admin_proxies_nodes_cert_deploy_installed();
    case "in_use":
      return m.admin_proxies_nodes_cert_deploy_in_use();
    case "error":
      return m.admin_proxies_nodes_cert_deploy_error();
    default:
      return null;
  }
}

export interface NodeCertificateGuidanceProps {
  usage: NodeCertificateUsage;
  deployment: NodeCertificateDeployment;
  /** Certificates that exist but cannot be selected yet. */
  unusableCount: number;
  isReloading: boolean;
  onReload: () => void;
}

/**
 * Explains, under the certificate picker, what the current TLS configuration
 * does with certificates and where the chosen one stands on the server. Links
 * open in a new tab so the unsaved node form is never discarded; the reload
 * button picks up certificates created in that tab.
 */
export function NodeCertificateGuidance({
  usage,
  deployment,
  unusableCount,
  isReloading,
  onReload,
}: NodeCertificateGuidanceProps): React.ReactElement | null {
  if (usage === "tls_disabled") {
    return (
      <p className="text-xs text-muted-foreground">
        {m.admin_proxies_nodes_tls_disabled_help()}
      </p>
    );
  }
  if (usage !== "none_selected" && usage !== "managed") {
    return null;
  }

  const badge = deploymentBadge(deployment);
  const explanation = deploymentExplanation(deployment);

  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      {usage === "none_selected" ? (
        <p>{m.admin_proxies_nodes_tls_none_help()}</p>
      ) : null}
      {unusableCount > 0 ? (
        <p>{m.admin_proxies_nodes_cert_unusable({ count: unusableCount })}</p>
      ) : null}

      {explanation ? (
        <div
          className="space-y-1.5 rounded-lg border bg-background p-3"
          data-testid="node-certificate-deployment"
        >
          <div className="flex flex-wrap items-center gap-2">
            {badge ? (
              <Badge variant={badge.variant}>{badge.label}</Badge>
            ) : null}
            <span>{explanation}</span>
          </div>
          {deployment.kind === "error" &&
          (deployment.phase || deployment.message) ? (
            <p className="text-destructive">
              {deployment.phase ? `${deployment.phase}: ` : ""}
              {deployment.message}
            </p>
          ) : null}
          {deployment.kind !== "on_save" ? (
            <Link
              to={CERTIFICATES}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              {m.admin_proxies_nodes_cert_deploy_view()}
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          to={CERTIFICATES}
          target="_blank"
          rel="noreferrer"
          className={linkClass}
        >
          {m.admin_proxies_nodes_cert_manage()}
        </Link>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          loading={isReloading}
          onClick={onReload}
        >
          <RefreshCwIcon />
          {m.admin_proxies_nodes_cert_reload()}
        </Button>
      </div>
      <p>{m.admin_proxies_nodes_cert_new_tab_help()}</p>
    </div>
  );
}
