import { XIcon } from "lucide-react";
import { useState } from "react";

import { auditStatusLabel, targetTypeLabel } from "@/components/audit-labels";
import { DebouncedSearchInput } from "@/components/debounced-search-input";
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
  ADMIN_AUDIT_ACTION_FAMILIES,
  ADMIN_AUDIT_STATUSES,
  ADMIN_AUDIT_TARGET_TYPES,
} from "@/lib/admin-audit";
import type { AuditSearch } from "@/lib/admin-audit-search";
import { MCP_AUDIT_STATUSES } from "@/orpc/audit/schema";
import { m } from "@/paraglide/messages";

/** Sentinel for the "no filter" option; Select values cannot be undefined. */
const ALL = "all";

export interface AuditToolbarProps {
  tab: "admin" | "mcp";
  search: AuditSearch;
  /** Changes bump this to remount the text boxes (e.g. after clearing). */
  searchResetToken: number;
  hasFilters: boolean;
  onChange: (patch: Partial<AuditSearch>) => void;
  onClear: () => void;
}

/** Filter controls; every change is written to the URL by `onChange`. */
export function AuditToolbar({
  tab,
  search,
  searchResetToken,
  hasFilters,
  onChange,
  onClear,
}: AuditToolbarProps) {
  const isAdmin = tab === "admin";
  // Bumped when a family chip rewrites the prefix, to remount the text box.
  const [chipToken, setChipToken] = useState(0);

  const statusItems = [
    { label: m.admin_audit_filter_status_all(), value: ALL },
    ...(isAdmin ? ADMIN_AUDIT_STATUSES : MCP_AUDIT_STATUSES).map((value) => ({
      label: auditStatusLabel(value),
      value,
    })),
  ];
  const targetItems = [
    { label: m.admin_audit_filter_target_all(), value: ALL },
    ...ADMIN_AUDIT_TARGET_TYPES.map((value) => ({
      label: targetTypeLabel(value),
      value,
    })),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <DebouncedSearchInput
          key={`actor-${searchResetToken}`}
          defaultValue={search.actor ?? ""}
          placeholder={m.admin_audit_search_actor()}
          onSearch={(value) => onChange({ actor: value || undefined })}
        />
        <DebouncedSearchInput
          key={`action-${searchResetToken}-${chipToken}`}
          defaultValue={search.action ?? ""}
          placeholder={
            isAdmin
              ? m.admin_audit_search_action()
              : m.admin_audit_search_tool()
          }
          onSearch={(value) => onChange({ action: value || undefined })}
        />

        {isAdmin ? (
          <>
            <Select
              items={targetItems}
              value={search.targetType ?? ALL}
              onValueChange={(next) =>
                onChange({
                  targetType: next === ALL || next === null ? undefined : next,
                })
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {targetItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <DebouncedSearchInput
              key={`target-${searchResetToken}`}
              defaultValue={search.targetId ?? ""}
              placeholder={m.admin_audit_search_target_id()}
              onSearch={(value) => onChange({ targetId: value || undefined })}
            />
          </>
        ) : null}

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

        <Input
          aria-label={m.admin_audit_filter_from()}
          className="w-40"
          max={search.to}
          type="date"
          value={search.from ?? ""}
          onValueChange={(value) => onChange({ from: value || undefined })}
        />
        <Input
          aria-label={m.admin_audit_filter_to()}
          className="w-40"
          min={search.from}
          type="date"
          value={search.to ?? ""}
          onValueChange={(value) => onChange({ to: value || undefined })}
        />

        {hasFilters ? (
          <Button size="sm" variant="ghost" onClick={onClear}>
            <XIcon />
            {m.admin_audit_filter_clear()}
          </Button>
        ) : null}
      </div>

      {isAdmin ? (
        <div
          aria-label={m.admin_audit_filter_families()}
          className="flex flex-wrap items-center gap-1.5"
          role="group"
        >
          {ADMIN_AUDIT_ACTION_FAMILIES.map((family) => {
            const prefix = `${family}.`;
            const active = search.action === prefix;
            return (
              <Button
                aria-pressed={active}
                className="font-mono"
                key={family}
                size="xs"
                variant={active ? "secondary" : "outline"}
                onClick={() => {
                  setChipToken((token) => token + 1);
                  onChange({ action: active ? undefined : prefix });
                }}
              >
                {prefix}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
