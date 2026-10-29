import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REDEEM_BATCH_STATUSES, REDEEM_MODES } from "@/lib/redeem-batch";
import type { RedeemSearch } from "@/lib/redeem-search";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

import { MODE_LABELS, STATUS_LABELS } from "./redeem-labels";

/** Sentinel for the "no filter" option; Select values cannot be undefined. */
const ALL = "all";

export interface BatchToolbarProps {
  search: RedeemSearch;
  /** Changes bump this to remount the search box (e.g. after clearing). */
  searchResetToken: number;
  hasFilters: boolean;
  onChange: (patch: Partial<RedeemSearch>) => void;
  onClear: () => void;
}

/** Filter controls; every change is written to the URL by `onChange`. */
export function BatchToolbar({
  search,
  searchResetToken,
  hasFilters,
  onChange,
  onClear,
}: BatchToolbarProps) {
  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  const planItems = [
    { label: m.admin_redeem_filter_plan_all(), value: ALL },
    ...(plans ?? []).map((plan) => ({ label: plan.name, value: plan.id })),
  ];
  const modeItems = [
    { label: m.admin_redeem_filter_mode_all(), value: ALL },
    ...REDEEM_MODES.map((value) => ({ label: MODE_LABELS[value](), value })),
  ];
  const statusItems = [
    { label: m.admin_redeem_filter_status_all(), value: ALL },
    ...REDEEM_BATCH_STATUSES.map((value) => ({
      label: STATUS_LABELS[value](),
      value,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DebouncedSearchInput
        key={searchResetToken}
        defaultValue={search.q ?? ""}
        placeholder={m.admin_redeem_search_placeholder()}
        onSearch={(value) => onChange({ q: value || undefined })}
      />

      <Select
        items={planItems}
        value={search.plan ?? ALL}
        onValueChange={(next) =>
          onChange({ plan: next === ALL ? undefined : (next as string) })
        }
      >
        <SelectTrigger className="w-48">
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

      <Select
        items={modeItems}
        value={search.mode ?? ALL}
        onValueChange={(next) =>
          onChange({
            mode: next === ALL ? undefined : (next as typeof search.mode),
          })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {modeItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <Select
        items={statusItems}
        value={search.status ?? ALL}
        onValueChange={(next) =>
          onChange({
            status: next === ALL ? undefined : (next as typeof search.status),
          })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {statusItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          <XIcon />
          {m.admin_redeem_filter_clear()}
        </Button>
      ) : null}
    </div>
  );
}
