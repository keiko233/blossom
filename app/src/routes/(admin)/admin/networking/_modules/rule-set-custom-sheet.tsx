import {
  ChevronDownIcon,
  DownloadIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLockFn } from "@/hooks/use-lock-fn";
import { formatBytes } from "@/lib/format";
import { suggestRuleSetVersion } from "@/lib/github-rule-set-catalog";
import { customRuleSetInputSchema } from "@/lib/networking-rule-set-schema";
import {
  type DefaultRule,
  type RuleSetRule,
  type RuleSetSource,
} from "@/lib/srs";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { createCustomRuleSet } from "@/query/networking-rule-sets";

import type { RuleSetRowView } from "./rule-set-table";
import {
  downloadCustomRuleSet,
  useRuleSetCustomValidation,
  type RuleSetEditorMode,
} from "./use-rule-set-custom";

export interface RuleSetCustomPrefill {
  ruleSetId: string;
  version: string;
  source: RuleSetSource;
}

export interface RuleSetCustomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: readonly RuleSetRowView[];
  prefill: RuleSetCustomPrefill | null;
  onSaved: () => Promise<void> | void;
}

const LIST_FIELDS = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "domain_regex",
  "ip_cidr",
  "source_ip_cidr",
  "port",
  "port_range",
] as const;

type ListField = (typeof LIST_FIELDS)[number];

function emptyRule(): DefaultRule {
  return {};
}

function sourceFromRules(rules: RuleSetRule[]): RuleSetSource {
  return { version: 1, rules };
}

function ruleSummary(rule: RuleSetRule): string {
  if (rule.type === "logical")
    return m.admin_networking_rulesets_custom_logical();
  const parts: string[] = [];
  if (rule.domain?.length)
    parts.push(
      m.admin_networking_rulesets_custom_summary_domains({
        count: rule.domain.length,
      }),
    );
  if (rule.domain_suffix?.length)
    parts.push(
      m.admin_networking_rulesets_custom_summary_suffixes({
        count: rule.domain_suffix.length,
      }),
    );
  if (rule.ip_cidr?.length)
    parts.push(
      m.admin_networking_rulesets_custom_summary_cidrs({
        count: rule.ip_cidr.length,
      }),
    );
  if (rule.port?.length)
    parts.push(
      m.admin_networking_rulesets_custom_summary_ports({
        count: rule.port.length,
      }),
    );
  return parts.length > 0
    ? parts.join(" · ")
    : m.admin_networking_rulesets_custom_summary_empty();
}

function linesToValues(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function ruleListValue(rule: DefaultRule, field: ListField): string {
  if (field === "port") {
    return (rule.port ?? []).join("\n");
  }
  const values = rule[field];
  return Array.isArray(values) ? values.join("\n") : "";
}

function setRuleListValue(
  rule: DefaultRule,
  field: ListField,
  raw: string,
): DefaultRule {
  const values = linesToValues(raw);
  if (field === "port") {
    const ports = values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
    return { ...rule, port: ports.length > 0 ? ports : undefined };
  }
  return {
    ...rule,
    [field]: values.length > 0 ? values : undefined,
  };
}

function ListFieldEditor({
  label,
  value,
  onChange,
  pathError,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  pathError: string | null;
}): React.ReactElement {
  const count = linesToValues(value).length;
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        aria-invalid={pathError ? true : undefined}
        className={cn(pathError && "border-destructive/36")}
        onChange={(event) => onChange(event.target.value)}
        placeholder={m.admin_networking_rulesets_custom_one_per_line()}
        rows={3}
        value={value}
      />
      <FieldDescription>
        {m.admin_networking_rulesets_custom_value_count({ count })}
        {pathError ? ` · ${pathError}` : ""}
      </FieldDescription>
    </Field>
  );
}

function StructuredRuleEditor({
  rule,
  onChange,
  onRemove,
  errorPath,
}: {
  rule: DefaultRule;
  onChange: (rule: DefaultRule) => void;
  onRemove: () => void;
  errorPath: string | null;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const update = (field: ListField, value: string) =>
    onChange(setRuleListValue(rule, field, value));

  return (
    <Collapsible
      className="border-b last:border-b-0"
      onOpenChange={setOpen}
      open={open}
    >
      <div className="flex h-9 items-center gap-2">
        <CollapsibleTrigger
          render={<Button size="icon-xs" variant="ghost" />}
          aria-expanded={open}
        >
          <ChevronDownIcon
            className={cn("transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <span className="min-w-0 flex-1 truncate text-sm">
          {ruleSummary(rule)}
        </span>
        <Button
          aria-label={m.admin_networking_rulesets_custom_remove_rule()}
          size="icon-xs"
          variant="ghost"
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <CollapsiblePanel>
        <div className="grid gap-3 pb-4 sm:grid-cols-2">
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_domain()}
            onChange={(value) => update("domain", value)}
            pathError={errorPath?.startsWith("domain") ? errorPath : null}
            value={ruleListValue(rule, "domain")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_suffix()}
            onChange={(value) => update("domain_suffix", value)}
            pathError={
              errorPath?.startsWith("domain_suffix") ? errorPath : null
            }
            value={ruleListValue(rule, "domain_suffix")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_keyword()}
            onChange={(value) => update("domain_keyword", value)}
            pathError={
              errorPath?.startsWith("domain_keyword") ? errorPath : null
            }
            value={ruleListValue(rule, "domain_keyword")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_regex()}
            onChange={(value) => update("domain_regex", value)}
            pathError={errorPath?.startsWith("domain_regex") ? errorPath : null}
            value={ruleListValue(rule, "domain_regex")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_ip()}
            onChange={(value) => update("ip_cidr", value)}
            pathError={errorPath?.startsWith("ip_cidr") ? errorPath : null}
            value={ruleListValue(rule, "ip_cidr")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_source_ip()}
            onChange={(value) => update("source_ip_cidr", value)}
            pathError={
              errorPath?.startsWith("source_ip_cidr") ? errorPath : null
            }
            value={ruleListValue(rule, "source_ip_cidr")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_ports()}
            onChange={(value) => update("port", value)}
            pathError={errorPath?.startsWith("port") ? errorPath : null}
            value={ruleListValue(rule, "port")}
          />
          <ListFieldEditor
            label={m.admin_networking_rulesets_custom_field_port_ranges()}
            onChange={(value) => update("port_range", value)}
            pathError={errorPath?.startsWith("port_range") ? errorPath : null}
            value={ruleListValue(rule, "port_range")}
          />
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              {m.admin_networking_rulesets_custom_field_network()}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              {(["tcp", "udp", "icmp"] as const).map((network) => (
                <label
                  className="flex items-center gap-1.5 text-sm"
                  key={network}
                >
                  <input
                    checked={rule.network?.includes(network) ?? false}
                    className="size-3.5 accent-primary"
                    onChange={(event) => {
                      const next = new Set(rule.network ?? []);
                      if (event.target.checked) next.add(network);
                      else next.delete(network);
                      onChange({
                        ...rule,
                        network: next.size > 0 ? [...next] : undefined,
                      });
                    }}
                    type="checkbox"
                  />
                  {network}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-2 text-sm">
            {m.admin_networking_rulesets_custom_field_invert()}
            <Switch
              checked={rule.invert ?? false}
              onCheckedChange={(checked) =>
                onChange({ ...rule, invert: checked || undefined })
              }
            />
          </label>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function formatStats(
  stats: ReturnType<typeof useRuleSetCustomValidation>["stats"],
): string {
  if (!stats) return "";
  return m.admin_networking_rulesets_custom_stats({
    rules: stats.rules,
    domains: stats.domains,
    suffixes: stats.suffixes,
    cidrs: stats.cidrs,
    ports: stats.ports,
  });
}

export function RuleSetCustomSheet({
  open,
  onOpenChange,
  existing,
  prefill,
  onSaved,
}: RuleSetCustomSheetProps): React.ReactElement {
  const [ruleSetId, setRuleSetId] = useState("");
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<RuleSetEditorMode>("structured");
  const [rules, setRules] = useState<DefaultRule[]>([emptyRule()]);
  const [jsonText, setJsonText] = useState("");
  const [modeError, setModeError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const existingVersions = existing
    .filter((row) => row.ruleSetId === ruleSetId.trim())
    .map((row) => row.version);

  const source = sourceFromRules(rules);
  const validation = useRuleSetCustomValidation(
    mode === "structured" ? source : safeJson(jsonText),
  );
  const formValidation = customRuleSetInputSchema.safeParse({
    ruleSetId: ruleSetId.trim(),
    version: version.trim(),
    mode,
    rules: mode === "structured" ? source : safeJson(jsonText),
  });

  useEffect(() => {
    if (!open) return;
    const versions = existing
      .filter((row) => row.ruleSetId === prefill?.ruleSetId)
      .map((row) => row.version);
    const nextVersion = suggestRuleSetVersion(versions);
    const prefilledRules = prefill?.source.rules ?? [emptyRule()];
    const hasLogical = prefilledRules.some((rule) => rule.type === "logical");
    setRuleSetId(prefill?.ruleSetId ?? "");
    setVersion(nextVersion);
    setMode(hasLogical ? "json" : "structured");
    setRules(
      prefilledRules.every((rule) => rule.type !== "logical")
        ? (prefilledRules as DefaultRule[])
        : [emptyRule()],
    );
    setJsonText(
      JSON.stringify(prefill?.source ?? { version: 1, rules: [] }, null, 2),
    );
    setModeError(null);
    setSaveError(null);
  }, [open, prefill]);

  const switchMode = (next: RuleSetEditorMode) => {
    setModeError(null);
    if (next === "json") {
      setJsonText(JSON.stringify(source, null, 2));
      setMode(next);
      return;
    }
    const parsed = safeJson(jsonText);
    if (!isRuleSetSource(parsed)) {
      setModeError(m.admin_networking_rulesets_custom_invalid_json());
      return;
    }
    if (parsed.rules.some((rule) => rule.type === "logical")) {
      setModeError(m.admin_networking_rulesets_custom_logical_unsupported());
      return;
    }
    setRules(parsed.rules as DefaultRule[]);
    setMode(next);
  };

  const save = useLockFn(async () => {
    setSaveError(null);
    setSaving(true);
    const payload = mode === "structured" ? source : safeJson(jsonText);
    const result = await createCustomRuleSet({
      data: {
        ruleSetId: ruleSetId.trim(),
        version: version.trim(),
        mode,
        rules: payload,
      },
    });
    setSaving(false);
    if (!result.ok) {
      if (result.reason === "duplicate_rule_set") {
        setVersion(suggestRuleSetVersion(existingVersions));
      }
      setSaveError(
        result.reason === "duplicate_rule_set"
          ? m.admin_networking_write_duplicate_rule_set()
          : result.reason === "asset_too_large"
            ? m.admin_networking_write_asset_too_large()
            : m.admin_networking_rulesets_custom_invalid_rules(),
      );
      return;
    }
    await onSaved();
    onOpenChange(false);
  });

  const download = useLockFn(async () => {
    const payload = mode === "structured" ? source : safeJson(jsonText);
    await downloadCustomRuleSet(payload, ruleSetId.trim() || "rule-set");
  });

  const formatJson = () => {
    setModeError(null);
    try {
      setJsonText(JSON.stringify(JSON.parse(jsonText), null, 2));
    } catch {
      setModeError(m.admin_networking_rulesets_custom_invalid_json());
    }
  };

  const errorPath = validation.path;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="sm:max-w-2xl 2xl:max-w-3xl" side="right">
        <SheetHeader>
          <SheetTitle>{m.admin_networking_rulesets_custom_title()}</SheetTitle>
          <SheetDescription>
            {m.admin_networking_rulesets_custom_description()}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_custom_field_id()}
              </FieldLabel>
              <Input
                maxLength={64}
                onChange={(event) => setRuleSetId(event.target.value)}
                placeholder="custom-cn"
                value={ruleSetId}
              />
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_custom_field_version()}
              </FieldLabel>
              <Input
                maxLength={64}
                onChange={(event) => setVersion(event.target.value)}
                value={version}
              />
              <FieldDescription>
                {m.admin_networking_rulesets_custom_version_hint()}
              </FieldDescription>
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ToggleGroup
                onValueChange={(value) => {
                  const next = (value as RuleSetEditorMode[])[0];
                  if (next) switchMode(next);
                }}
                value={[mode]}
              >
                <ToggleGroupItem value="structured">
                  {m.admin_networking_rulesets_custom_mode_rules()}
                </ToggleGroupItem>
                <ToggleGroupItem value="json">
                  {m.admin_networking_rulesets_custom_mode_json()}
                </ToggleGroupItem>
              </ToggleGroup>
              {mode === "json" ? (
                <Button size="xs" variant="ghost" onClick={formatJson}>
                  {m.admin_networking_rulesets_custom_format()}
                </Button>
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">
              {formatStats(validation.stats)}
              {validation.payloadBytes !== null
                ? ` · ${m.admin_networking_rulesets_custom_payload({
                    size: formatBytes(validation.payloadBytes),
                  })}`
                : ""}
            </span>
          </div>

          {modeError ? (
            <Alert className="mt-3" variant="error">
              <AlertDescription>{modeError}</AlertDescription>
            </Alert>
          ) : null}

          {mode === "structured" ? (
            <div className="mt-4 rounded-lg border">
              {rules.map((rule, index) => (
                <StructuredRuleEditor
                  errorPath={
                    errorPath?.startsWith(`rules[${index}]`) ? errorPath : null
                  }
                  key={index}
                  onChange={(next) =>
                    setRules((current) =>
                      current.map((row, rowIndex) =>
                        rowIndex === index ? next : row,
                      ),
                    )
                  }
                  onRemove={() =>
                    setRules((current) =>
                      current.filter((_, rowIndex) => rowIndex !== index),
                    )
                  }
                  rule={rule}
                />
              ))}
              <div className="p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setRules((current) => [...current, emptyRule()])
                  }
                >
                  <PlusIcon />
                  {m.admin_networking_rulesets_custom_add_rule()}
                </Button>
              </div>
            </div>
          ) : (
            <Field className="mt-4">
              <FieldLabel>
                {m.admin_networking_rulesets_custom_json_label()}
              </FieldLabel>
              <Textarea
                aria-invalid={validation.ok ? undefined : true}
                className="min-h-64 font-mono text-xs"
                onChange={(event) => setJsonText(event.target.value)}
                spellCheck={false}
                value={jsonText}
              />
              <FieldDescription>
                {m.admin_networking_rulesets_custom_json_hint()}
              </FieldDescription>
            </Field>
          )}

          {validation.message ? (
            <p className="mt-3 text-xs text-destructive-foreground">
              {m.admin_networking_rulesets_custom_validation({
                code: validation.message,
                path: validation.path ?? "",
              })}
            </p>
          ) : null}
          {saveError ? (
            <p
              className="mt-3 text-sm text-destructive-foreground"
              role="alert"
            >
              {saveError}
            </p>
          ) : null}
        </SheetPanel>
        <SheetFooter>
          <Button
            disabled={!validation.ok || !formValidation.success || saving}
            loading={saving}
            onClick={() => void save()}
          >
            {m.admin_networking_rulesets_custom_save()}
          </Button>
          <Button
            disabled={!validation.ok}
            variant="outline"
            onClick={() => void download()}
          >
            <DownloadIcon />
            {m.admin_networking_rulesets_custom_download()}
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRuleSetSource(value: unknown): value is RuleSetSource {
  try {
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] !== "object") return false;
      return true;
    }
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return Array.isArray(record.rules);
  } catch {
    return false;
  }
}
