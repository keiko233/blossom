import { XIcon } from "lucide-react";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EXPIRING_DAY_OPTIONS,
  type SubscriptionsSearch,
} from "@/lib/subscription-search";
import { m } from "@/paraglide/messages";
import type { PlanListItem } from "@/query/plans";

/** Sentinel for the "no filter" option; Select values cannot be undefined. */
const ALL = "all";

const STATUS_OPTIONS = ["active", "expired", "cancelled"] as const;
const QUOTA_OPTIONS = ["near", "over"] as const;

function statusLabel(status: (typeof STATUS_OPTIONS)[number]): string {
  switch (status) {
    case "active":
      return m.admin_subscriptions_status_active();
    case "expired":
      return m.admin_subscriptions_status_expired();
    case "cancelled":
      return m.admin_subscriptions_status_cancelled();
  }
}

function quotaLabel(quota: (typeof QUOTA_OPTIONS)[number]): string {
  return quota === "near"
    ? m.admin_subscriptions_filter_quota_near()
    : m.admin_subscriptions_filter_quota_over();
}

export interface SubscriptionToolbarProps {
  search: SubscriptionsSearch;
  plans: PlanListItem[];
  /** Changes bump this to remount the search box (e.g. after clearing). */
  searchResetToken: number;
  hasFilters: boolean;
  onChange: (patch: Partial<SubscriptionsSearch>) => void;
  onClear: () => void;
}

/** Filter controls; every change is written to the URL by `onChange`. */
export function SubscriptionToolbar({
  search,
  plans,
  searchResetToken,
  hasFilters,
  onChange,
  onClear,
}: SubscriptionToolbarProps) {
  const statusItems = [
    { label: m.admin_subscriptions_filter_status_all(), value: ALL },
    ...STATUS_OPTIONS.map((value) => ({ label: statusLabel(value), value })),
  ];
  const planItems = [
    { label: m.admin_subscriptions_filter_plan_all(), value: ALL },
    ...plans.map((plan) => ({ label: plan.name, value: plan.id })),
  ];
  const expiringItems = [
    { label: m.admin_subscriptions_filter_expiring_any(), value: ALL },
    ...EXPIRING_DAY_OPTIONS.map((days) => ({
      label: m.admin_subscriptions_filter_expiring_days({ days }),
      value: String(days),
    })),
  ];
  const quotaItems = [
    { label: m.admin_subscriptions_filter_quota_any(), value: ALL },
    ...QUOTA_OPTIONS.map((value) => ({ label: quotaLabel(value), value })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DebouncedSearchInput
        key={searchResetToken}
        defaultValue={search.q ?? ""}
        placeholder={m.admin_subscriptions_search_placeholder()}
        onSearch={(value) => onChange({ q: value || undefined })}
      />

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

      <Select
        items={planItems}
        value={search.plan ?? ALL}
        onValueChange={(next) =>
          onChange({ plan: next === ALL ? undefined : (next as string) })
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

      <Select
        items={expiringItems}
        value={search.expiring === undefined ? ALL : String(search.expiring)}
        onValueChange={(next) =>
          onChange({ expiring: next === ALL ? undefined : Number(next) })
        }
      >
        <SelectTrigger className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {expiringItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <Select
        items={quotaItems}
        value={search.quota ?? ALL}
        onValueChange={(next) =>
          onChange({
            quota: next === ALL ? undefined : (next as typeof search.quota),
          })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {quotaItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={search.stored === true}
          disabled={search.status === undefined}
          onCheckedChange={(checked) =>
            onChange({ stored: checked ? true : undefined })
          }
        />
        {m.admin_subscriptions_filter_stored_status()}
      </label>

      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          <XIcon />
          {m.admin_subscriptions_filter_clear()}
        </Button>
      ) : null}
    </div>
  );
}
