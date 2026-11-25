import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useLockFn } from "@/hooks/use-lock-fn";
import { formatBytes } from "@/lib/format";
import {
  deriveRuleSetId,
  parseOfficialName,
  type OfficialRuleSetRepo,
} from "@/lib/github-rule-set-catalog";
import { MANAGED_RULE_SET_PRESET_CATALOG } from "@/lib/networking-workspace";
import { m } from "@/paraglide/messages";
import { importOfficialRuleSet } from "@/query/networking-rule-sets";

import type { RuleSetRowView } from "./rule-set-table";
import { useRuleSetOfficialCatalog } from "./use-rule-set-official";

const ROW_HEIGHT = 36;

interface ImportStatus {
  key: string;
  label: string;
  state: "success" | "warning" | "error";
}

function safeOfficialId(repo: OfficialRuleSetRepo, name: string): string {
  try {
    return deriveRuleSetId(repo, name);
  } catch {
    return name;
  }
}

export interface RuleSetOfficialSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: readonly RuleSetRowView[];
  onImported: () => Promise<void> | void;
  onOpenUpload: () => void;
}

function importedIds(existing: readonly RuleSetRowView[]): Set<string> {
  return new Set(existing.map((row) => row.ruleSetId));
}

export function RuleSetOfficialSheet({
  open,
  onOpenChange,
  existing,
  onImported,
  onOpenUpload,
}: RuleSetOfficialSheetProps): React.ReactElement {
  const catalog = useRuleSetOfficialCatalog();
  const [repo, setRepo] = useState<OfficialRuleSetRepo>("geosite");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<ImportStatus[]>([]);
  const [exactName, setExactName] = useState("");
  const [exactStatus, setExactStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatuses([]);
    setExactStatus(null);
    setSelected(new Set());
  }, [open]);

  const repoView =
    catalog.data?.ok === true
      ? (catalog.data.repos.find((entry) => entry.repo === repo) ?? null)
      : null;
  const already = importedIds(existing);
  const entries = (repoView?.entries ?? []).filter(
    (entry) =>
      query.trim() === "" ||
      entry.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const moveSelection = (offset: number) => {
    if (entries.length === 0) return;
    const target = document.activeElement;
    const current =
      target instanceof HTMLElement && target.dataset.ruleSetName
        ? entries.findIndex(
            (entry) => entry.name === target.dataset.ruleSetName,
          )
        : -1;
    if (current === -1) {
      scrollRef.current
        ?.querySelector<HTMLElement>(
          `[data-rule-set-name="${CSS.escape(entries[0]!.name)}"]`,
        )
        ?.focus();
      return;
    }
    const nextIndex = Math.min(
      entries.length - 1,
      Math.max(0, current + offset),
    );
    const next = entries[nextIndex];
    if (!next) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(
        `[data-rule-set-name="${CSS.escape(next.name)}"]`,
      )
      ?.focus();
  };

  const quickPicks = MANAGED_RULE_SET_PRESET_CATALOG.filter(
    (preset) => preset.repo === repo,
  );

  const runImport = async (
    repoValue: OfficialRuleSetRepo,
    name: string,
  ): Promise<ImportStatus> => {
    const result = await importOfficialRuleSet({
      data: { repo: repoValue, name },
    });
    if (result.ok) {
      return {
        key: `${repoValue}:${name}`,
        label: m.admin_networking_rulesets_official_status_imported({
          id: result.ruleSetId,
        }),
        state: "success",
      };
    }
    if (result.reason === "duplicate_rule_set") {
      return {
        key: `${repoValue}:${name}`,
        label: m.admin_networking_rulesets_official_status_duplicate({
          id: safeOfficialId(repoValue, name),
        }),
        state: "warning",
      };
    }
    return {
      key: `${repoValue}:${name}`,
      label: m.admin_networking_rulesets_official_status_failed({
        id: safeOfficialId(repoValue, name),
        reason: officialReasonMessage(result.reason),
      }),
      state: "error",
    };
  };

  const importSelected = useLockFn(async () => {
    if (selected.size === 0) return;
    setImporting(true);
    // Selection survives filtering, so import every selected name rather than
    // only the rows the current search happens to show.
    const names = [...selected];
    const results: ImportStatus[] = [];
    for (const name of names) {
      try {
        results.push(await runImport(repo, name));
      } catch {
        results.push({
          key: `${repo}:${name}`,
          label: m.admin_networking_rulesets_official_status_failed({
            id: safeOfficialId(repo, name),
            reason: m.admin_networking_write_upstream_unavailable(),
          }),
          state: "error",
        });
      }
      setStatuses([...results]);
    }
    setSelected(new Set());
    setImporting(false);
    await onImported();
  });

  const importExact = useLockFn(async () => {
    const name = exactName.trim();
    if (!name) return;
    if (!parseOfficialName(repo, name)) {
      setExactStatus(m.admin_networking_rulesets_official_invalid_name());
      return;
    }
    setImporting(true);
    const result = await runImport(repo, name);
    setStatuses((current) => [...current, result]);
    setExactStatus(result.label);
    setImporting(false);
    await onImported();
  });

  const catalogFailure = catalog.data?.ok === false ? catalog.data : null;
  const failed = catalogFailure !== null;
  const failureReason = catalogFailure?.reason ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="sm:max-w-xl" side="right">
        <SheetHeader>
          <SheetTitle>
            {m.admin_networking_rulesets_official_title()}
          </SheetTitle>
          <SheetDescription>
            {m.admin_networking_rulesets_official_description()}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <Tabs
            onValueChange={(value) => {
              setRepo(value as OfficialRuleSetRepo);
              setSelected(new Set());
              setQuery("");
            }}
            value={repo}
          >
            <TabsList variant="underline">
              <TabsTab value="geosite">
                {m.admin_networking_rulesets_official_tab_geosite()}
              </TabsTab>
              <TabsTab value="geoip">
                {m.admin_networking_rulesets_official_tab_geoip()}
              </TabsTab>
            </TabsList>
            <TabsPanel value="geosite" />
            <TabsPanel value="geoip" />
          </Tabs>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <DebouncedSearchInput
              defaultValue=""
              key={`${repo}-${query === "" ? "empty" : "typed"}`}
              onSearch={setQuery}
              placeholder={m.admin_networking_rulesets_official_search()}
            />
            <span className="text-xs text-muted-foreground">
              {repoView
                ? m.admin_networking_rulesets_official_updated({
                    date: repoView.committedAt
                      ? repoView.committedAt.slice(0, 10)
                      : m.admin_networking_rulesets_official_unknown_date(),
                    sha: repoView.commit.slice(0, 7),
                  })
                : null}
            </span>
          </div>

          {failed ? (
            <Alert className="mt-3" variant="warning">
              <AlertTitle>
                {failureReason === "upstream_rate_limited"
                  ? m.admin_networking_rulesets_official_rate_limited()
                  : m.admin_networking_rulesets_official_unavailable()}
              </AlertTitle>
              <AlertDescription>
                {m.admin_networking_rulesets_official_unavailable_description()}
                <Button
                  className="w-fit"
                  size="xs"
                  variant="outline"
                  onClick={onOpenUpload}
                >
                  {m.admin_networking_rulesets_table_add_upload()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {quickPicks.length > 0 && !failed ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {m.admin_networking_rulesets_official_quick_picks()}
              </span>
              {quickPicks.map((preset) => (
                <Button
                  key={preset.id}
                  size="xs"
                  variant={selected.has(preset.name) ? "default" : "outline"}
                  onClick={() => toggle(preset.name)}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          ) : null}

          {failed || catalog.data?.ok === false ? (
            <div className="mt-4 flex flex-col gap-2">
              <Field>
                <FieldLabel>
                  {m.admin_networking_rulesets_official_exact_name()}
                </FieldLabel>
                <div className="flex w-full gap-2">
                  <Input
                    onChange={(event) => setExactName(event.target.value)}
                    placeholder="cn"
                    value={exactName}
                  />
                  <Button
                    disabled={importing || exactName.trim() === ""}
                    onClick={() => void importExact()}
                  >
                    {m.admin_networking_rulesets_official_import_exact()}
                  </Button>
                </div>
              </Field>
              {exactStatus ? (
                <p className="text-xs text-muted-foreground">{exactStatus}</p>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void catalog.refetch()}
              >
                <RefreshCwIcon />
                {m.admin_networking_rulesets_official_retry()}
              </Button>
            </div>
          ) : catalog.isPending ? (
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: 8 }, (_, index) => (
                <div
                  className="h-9 animate-pulse rounded-md bg-muted"
                  key={index}
                />
              ))}
            </div>
          ) : (
            <div
              className="mt-3 h-72 overflow-y-auto rounded-lg border"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveSelection(1);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSelection(-1);
                  return;
                }
                if (event.key !== " " && event.key !== "Spacebar") return;
                const focused = event.target;
                if (!(focused instanceof HTMLElement)) return;
                const name = focused.dataset.ruleSetName;
                if (!name) return;
                event.preventDefault();
                toggle(name);
              }}
              ref={scrollRef}
            >
              <div
                className="relative w-full"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const entry = entries[virtualRow.index]!;
                  const isImported = already.has(
                    safeOfficialId(repo, entry.name),
                  );
                  return (
                    <div
                      className="absolute inset-x-0 flex h-9 items-center gap-2 border-b px-2 text-sm last:border-b-0"
                      data-rule-set-name={entry.name}
                      key={entry.name}
                      role="listitem"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <Checkbox
                        aria-label={entry.name}
                        checked={selected.has(entry.name)}
                        data-rule-set-name={entry.name}
                        onCheckedChange={() => toggle(entry.name)}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {entry.name}
                      </span>
                      {isImported ? (
                        <Badge size="sm" variant="outline">
                          {m.admin_networking_rulesets_official_imported()}
                        </Badge>
                      ) : null}
                      <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
                        {formatBytes(entry.sizeBytes)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {statuses.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-1.5">
              {statuses.map((status) => (
                <li
                  className="flex items-center gap-2 text-xs"
                  key={`${status.key}:${status.label}`}
                >
                  <StatusDot
                    tone={
                      status.state === "success"
                        ? "success"
                        : status.state === "warning"
                          ? "warning"
                          : "danger"
                    }
                  />
                  <span className="min-w-0 truncate">{status.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </SheetPanel>
        <SheetFooter>
          <Button
            disabled={selected.size === 0 || importing}
            loading={importing}
            onClick={() => void importSelected()}
          >
            <CheckIcon />
            {m.admin_networking_rulesets_official_import_selected({
              count: selected.size,
            })}
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

function officialReasonMessage(reason: string): string {
  switch (reason) {
    case "duplicate_rule_set":
      return m.admin_networking_write_duplicate_rule_set();
    case "asset_too_large":
      return m.admin_networking_write_asset_too_large();
    case "upstream_not_found":
      return m.admin_networking_write_upstream_not_found();
    case "upstream_rate_limited":
      return m.admin_networking_write_upstream_rate_limited();
    case "upstream_invalid_asset":
      return m.admin_networking_write_upstream_invalid_asset();
    default:
      return m.admin_networking_write_upstream_unavailable();
  }
}
