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
import type { UsersSearch } from "@/lib/user-search";
import { m } from "@/paraglide/messages";

/** Sentinel for the "no filter" option; Select values cannot be undefined. */
const ALL = "all";

const ROLE_OPTIONS = ["admin", "user"] as const;
const STATUS_OPTIONS = ["active", "banned"] as const;
const SUBSCRIPTION_OPTIONS = ["active", "none"] as const;

function roleLabel(role: (typeof ROLE_OPTIONS)[number]): string {
  return role === "admin"
    ? m.admin_users_role_admin()
    : m.admin_users_role_user();
}

function statusLabel(status: (typeof STATUS_OPTIONS)[number]): string {
  return status === "banned"
    ? m.admin_users_status_banned()
    : m.admin_users_status_active();
}

function subscriptionLabel(
  subscription: (typeof SUBSCRIPTION_OPTIONS)[number],
): string {
  return subscription === "active"
    ? m.admin_users_filter_subscription_active()
    : m.admin_users_filter_subscription_none();
}

export interface UserToolbarProps {
  search: UsersSearch;
  /** Changes bump this to remount the search box (e.g. after clearing). */
  searchResetToken: number;
  hasFilters: boolean;
  onChange: (patch: Partial<UsersSearch>) => void;
  onClear: () => void;
}

/** Filter controls; every change is written to the URL by `onChange`. */
export function UserToolbar({
  search,
  searchResetToken,
  hasFilters,
  onChange,
  onClear,
}: UserToolbarProps) {
  const roleItems = [
    { label: m.admin_users_filter_role_all(), value: ALL },
    ...ROLE_OPTIONS.map((value) => ({ label: roleLabel(value), value })),
  ];
  const statusItems = [
    { label: m.admin_users_filter_status_all(), value: ALL },
    ...STATUS_OPTIONS.map((value) => ({ label: statusLabel(value), value })),
  ];
  const subscriptionItems = [
    { label: m.admin_users_filter_subscription_any(), value: ALL },
    ...SUBSCRIPTION_OPTIONS.map((value) => ({
      label: subscriptionLabel(value),
      value,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DebouncedSearchInput
        key={searchResetToken}
        defaultValue={search.q ?? ""}
        placeholder={m.admin_users_search_placeholder()}
        onSearch={(value) => onChange({ q: value || undefined })}
      />

      <Select
        items={roleItems}
        value={search.role ?? ALL}
        onValueChange={(next) =>
          onChange({
            role: next === ALL ? undefined : (next as typeof search.role),
          })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {roleItems.map((item) => (
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

      <Select
        items={subscriptionItems}
        value={search.subscription ?? ALL}
        onValueChange={(next) =>
          onChange({
            subscription:
              next === ALL ? undefined : (next as typeof search.subscription),
          })
        }
      >
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {subscriptionItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          <XIcon />
          {m.admin_users_filter_clear()}
        </Button>
      ) : null}
    </div>
  );
}
