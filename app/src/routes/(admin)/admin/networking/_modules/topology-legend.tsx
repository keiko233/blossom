import { SwatchBookIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import {
  TOPOLOGY_EDGE_LEGEND,
  type LinkEdgeStyle,
} from "@/lib/networking-topology";
import { m } from "@/paraglide/messages";

import {
  EDGE_DASH_ARRAY,
  EDGE_TONE_COLOR,
  LEGEND_LABEL,
} from "./topology-labels";

function LegendLine({ style }: { style: LinkEdgeStyle }): React.ReactElement {
  return (
    <svg aria-hidden className="h-2 w-10 shrink-0" viewBox="0 0 40 8">
      <line
        x1="0"
        y1="4"
        x2="34"
        y2="4"
        style={{
          stroke: EDGE_TONE_COLOR[style.tone],
          strokeWidth: style.width,
          strokeDasharray: EDGE_DASH_ARRAY[style.dash],
        }}
      />
      <path
        d="M34 1 L40 4 L34 7 Z"
        style={{ fill: EDGE_TONE_COLOR[style.tone] }}
      />
    </svg>
  );
}

/**
 * Renders the same `TOPOLOGY_EDGE_LEGEND` table the edges read, so the two
 * cannot drift apart.
 */
export function TopologyLegend({
  disabled = false,
}: {
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button disabled={disabled} size="xs" variant="ghost" />}
      >
        <SwatchBookIcon />
        {m.admin_networking_topology_wb_legend()}
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-64">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {m.admin_networking_topology_wb_legend_title()}
        </p>
        <ul className="flex flex-col gap-2">
          {TOPOLOGY_EDGE_LEGEND.map((entry) => (
            <li
              key={entry.key}
              className="flex items-center gap-3 text-xs"
              data-slot="topology-legend-row"
            >
              <LegendLine style={entry.style} />
              <span className="min-w-0 flex-1">
                {(LEGEND_LABEL[entry.key] ?? (() => entry.key))()}
              </span>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
