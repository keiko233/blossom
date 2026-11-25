import type {
  EdgeTone,
  TopologyLinkHealth,
  TopologyLinkPhase,
} from "@/lib/networking-topology";
import { m } from "@/paraglide/messages";

export const PHASE_LABEL: Record<TopologyLinkPhase, () => string> = {
  draft: m.admin_networking_link_phase_draft,
  pending: m.admin_networking_link_phase_pending,
  applying: m.admin_networking_link_phase_applying,
  stalled: m.admin_networking_link_phase_stalled,
  failed: m.admin_networking_link_phase_failed,
  applied: m.admin_networking_link_phase_applied,
  removing: m.admin_networking_link_phase_removing,
};

export const HEALTH_LABEL: Record<TopologyLinkHealth, () => string> = {
  unknown: m.admin_networking_link_health_unknown,
  healthy: m.admin_networking_link_health_healthy,
  degraded: m.admin_networking_link_health_degraded,
};

/** CSS custom property each edge tone paints with. */
export const EDGE_TONE_COLOR: Record<EdgeTone, string> = {
  success: "var(--success)",
  info: "var(--info)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
  muted: "var(--muted-foreground)",
};

export const LEGEND_LABEL: Record<string, () => string> = {
  applied_healthy: m.admin_networking_topology_wb_legend_applied_healthy,
  applied_unknown: m.admin_networking_topology_wb_legend_applied_unknown,
  degraded: m.admin_networking_topology_wb_legend_degraded,
  pending: m.admin_networking_topology_wb_legend_pending,
  applying: m.admin_networking_topology_wb_legend_applying,
  stalled: m.admin_networking_topology_wb_legend_stalled,
  failed: m.admin_networking_topology_wb_legend_failed,
  draft: m.admin_networking_topology_wb_legend_draft,
  removing: m.admin_networking_topology_wb_legend_removing,
};

/** SVG dash pattern for each edge dash style. */
export const EDGE_DASH_ARRAY: Record<
  "solid" | "dashed" | "dotted",
  string | undefined
> = {
  solid: undefined,
  dashed: "6 4",
  dotted: "2 4",
};
