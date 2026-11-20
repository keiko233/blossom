import { XIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_TRAFFIC_PRESET,
  toUtcDay,
  TRAFFIC_PRESETS,
  type TrafficPreset,
  type TrafficRange,
} from "@/lib/traffic-analytics";
import type { TrafficSearch } from "@/lib/traffic-search";
import { m } from "@/paraglide/messages";
import type { TrafficFilterOptions } from "@/query/traffic-analytics";

import { TrafficUserFilter } from "./traffic-user-filter";

/** Sentinel for the "no filter" option; Select values cannot be undefined. */
const ALL = "all";

function presetLabel(preset: TrafficPreset): string {
  switch (preset) {
    case "24h":
      return m.admin_traffic_range_24h();
    case "7d":
      return m.admin_traffic_range_7d();
    case "30d":
      return m.admin_traffic_range_30d();
    case "90d":
      return m.admin_traffic_range_90d();
  }
}

export interface TrafficToolbarProps {
  search: TrafficSearch;
  /** The range the search params resolve to (shown in the date inputs). */
  range: TrafficRange;
  options: TrafficFilterOptions | undefined;
  hasFilters: boolean;
  onChange: (patch: Partial<TrafficSearch>) => void;
  onClear: () => void;
}

/** Range presets, custom UTC dates and entity filters; all state is the URL. */
export function TrafficToolbar({
  search,
  range,
  options,
  hasFilters,
  onChange,
  onClear,
}: TrafficToolbarProps): React.ReactElement {
  const isCustom = search.from !== undefined || search.to !== undefined;
  const activePreset = isCustom
    ? undefined
    : (search.range ?? DEFAULT_TRAFFIC_PRESET);
  const fromDay = toUtcDay(range.from);
  const toDay = toUtcDay(range.to - 1);

  const nodes = (options?.nodes ?? []).filter(
    (item) => !search.server || item.serverId === search.server,
  );
  const serverItems = [
    { label: m.admin_traffic_filter_server_all(), value: ALL },
    ...(options?.servers ?? []).map((item) => ({
      label: item.name,
      value: item.id,
    })),
  ];
  const nodeItems = [
    { label: m.admin_traffic_filter_node_all(), value: ALL },
    ...nodes.map((item) => ({ label: item.name, value: item.id })),
  ];
  const planItems = [
    { label: m.admin_traffic_filter_plan_all(), value: ALL },
    ...(options?.plans ?? []).map((item) => ({
      label: item.name,
      value: item.id,
    })),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          aria-label={m.admin_traffic_range_label()}
          className="flex items-center gap-1"
          role="group"
        >
          {TRAFFIC_PRESETS.map((preset) => (
            <Button
              aria-pressed={activePreset === preset}
              key={preset}
              size="sm"
              variant={activePreset === preset ? "secondary" : "outline"}
              onClick={() =>
                onChange({
                  range: preset === DEFAULT_TRAFFIC_PRESET ? undefined : preset,
                  from: undefined,
                  to: undefined,
                })
              }
            >
              {presetLabel(preset)}
            </Button>
          ))}
        </div>
        <Input
          aria-label={m.admin_traffic_filter_from()}
          className="w-40"
          max={toDay}
          type="date"
          value={fromDay}
          onValueChange={(value) =>
            value && onChange({ range: undefined, from: value, to: toDay })
          }
        />
        <Input
          aria-label={m.admin_traffic_filter_to()}
          className="w-40"
          min={fromDay}
          type="date"
          value={toDay}
          onValueChange={(value) =>
            value && onChange({ range: undefined, from: fromDay, to: value })
          }
        />
        <span className="text-xs text-muted-foreground">
          {m.admin_traffic_utc()}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={serverItems}
          value={search.server ?? ALL}
          onValueChange={(next) =>
            // A node belongs to one server: drop a node filter that no longer fits.
            onChange({
              server: next === ALL || next === null ? undefined : next,
              node: undefined,
            })
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {serverItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          items={nodeItems}
          value={search.node ?? ALL}
          onValueChange={(next) =>
            onChange({ node: next === ALL || next === null ? undefined : next })
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {nodeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          items={planItems}
          value={search.plan ?? ALL}
          onValueChange={(next) =>
            onChange({ plan: next === ALL || next === null ? undefined : next })
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {planItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <TrafficUserFilter
          userId={search.user}
          onChange={(user) => onChange({ user })}
        />

        {hasFilters ? (
          <Button size="sm" variant="ghost" onClick={onClear}>
            <XIcon />
            {m.admin_traffic_filter_clear()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
