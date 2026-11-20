import type React from "react";

import { Badge } from "@/components/ui/badge";
import { linkHealthTone, linkPhaseTone } from "@/lib/networking-topology";
import type {
  RoutingAction,
  RolloutStagePlan,
} from "@/lib/networking-workspace";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

const PHASE_LABEL: Record<Parameters<typeof linkPhaseTone>[0], () => string> = {
  draft: m.admin_networking_link_phase_draft,
  pending: m.admin_networking_link_phase_pending,
  applying: m.admin_networking_link_phase_applying,
  stalled: m.admin_networking_link_phase_stalled,
  failed: m.admin_networking_link_phase_failed,
  applied: m.admin_networking_link_phase_applied,
  removing: m.admin_networking_link_phase_removing,
};

const HEALTH_LABEL: Record<Parameters<typeof linkHealthTone>[0], () => string> =
  {
    unknown: m.admin_networking_link_health_unknown,
    healthy: m.admin_networking_link_health_healthy,
    degraded: m.admin_networking_link_health_degraded,
  };

const ROLLOUT_STATUS_LABEL: Record<string, () => string> = {
  applying: m.admin_networking_rollout_status_applying,
  stalled: m.admin_networking_rollout_status_stalled,
  recovering: m.admin_networking_rollout_status_recovering,
  completed: m.admin_networking_rollout_status_completed,
  failed: m.admin_networking_rollout_status_failed,
  aborted: m.admin_networking_rollout_status_aborted,
};

const STAGE_STATUS_LABEL: Record<string, () => string> = {
  pending: m.admin_networking_stage_status_pending,
  awaiting_proof: m.admin_networking_stage_status_awaiting_proof,
  awaiting_probe: m.admin_networking_stage_status_awaiting_probe,
  stalled: m.admin_networking_stage_status_stalled,
  probe_failed: m.admin_networking_stage_status_probe_failed,
  confirmed: m.admin_networking_stage_status_confirmed,
  recovering: m.admin_networking_stage_status_recovering,
  recovered: m.admin_networking_stage_status_recovered,
  superseded: m.admin_networking_stage_status_superseded,
};

function rolloutTone(status: string) {
  if (status === "completed") return "success" as const;
  if (status === "failed" || status === "aborted") return "error" as const;
  if (status === "stalled") return "warning" as const;
  if (status === "applying" || status === "recovering") return "info" as const;
  return "outline" as const;
}

function stageTone(status: string) {
  if (status === "confirmed" || status === "recovered")
    return "success" as const;
  if (status === "probe_failed" || status === "superseded")
    return "error" as const;
  if (status === "stalled") return "warning" as const;
  if (status === "awaiting_proof" || status === "awaiting_probe")
    return "info" as const;
  return "outline" as const;
}

export function LinkPhaseBadge({
  phase,
}: {
  phase: Parameters<typeof linkPhaseTone>[0];
}): React.ReactElement {
  return <Badge variant={linkPhaseTone(phase)}>{PHASE_LABEL[phase]()}</Badge>;
}

export function LinkHealthBadge({
  health,
}: {
  health: Parameters<typeof linkHealthTone>[0];
}): React.ReactElement {
  return (
    <Badge variant={linkHealthTone(health)}>{HEALTH_LABEL[health]()}</Badge>
  );
}

export function RolloutStatusBadge({
  status,
}: {
  status: string;
}): React.ReactElement {
  return (
    <Badge variant={rolloutTone(status)}>
      {(ROLLOUT_STATUS_LABEL[status] ?? (() => status))()}
    </Badge>
  );
}

export function StageStatusBadge({
  status,
}: {
  status: string;
}): React.ReactElement {
  return (
    <Badge variant={stageTone(status)}>
      {(STAGE_STATUS_LABEL[status] ?? (() => status))()}
    </Badge>
  );
}

export function RoutingActionBadge({
  action,
  network,
}: {
  action: RoutingAction | "sniff" | "resolve" | "fallback";
  network: "tcp" | "udp" | null;
}): React.ReactElement {
  const label =
    action === "route"
      ? m.admin_networking_routing_action_route()
      : action === "reject"
        ? m.admin_networking_routing_action_reject()
        : action === "sniff"
          ? m.admin_networking_routing_action_sniff()
          : action === "resolve"
            ? m.admin_networking_routing_action_resolve()
            : m.admin_networking_routing_action_fallback();
  const tone =
    action === "reject"
      ? "error"
      : action === "route"
        ? "success"
        : action === "fallback"
          ? "outline"
          : "info";
  return (
    <Badge variant={tone}>
      {label}
      {network ? ` · ${network.toUpperCase()}` : ""}
    </Badge>
  );
}

export function StageRoleBadge({
  role,
}: {
  role: RolloutStagePlan["stages"][number]["roles"][number];
}): React.ReactElement {
  const label =
    role === "receiver"
      ? m.admin_networking_routing_plan_receiver()
      : role === "sender"
        ? m.admin_networking_routing_plan_sender()
        : m.admin_networking_routing_plan_routing();
  return <Badge variant="outline">{label}</Badge>;
}

export function NetworkingSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section
      data-slot="networking-section"
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-medium">{title}</h2>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
