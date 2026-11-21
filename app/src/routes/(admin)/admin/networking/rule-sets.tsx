import { createFileRoute } from "@tanstack/react-router";
import { FileUpIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useLockFn } from "@/hooks/use-lock-fn";
import {
  MANAGED_RULE_SET_PRESET_CATALOG,
  type ManagedRuleSetPreset,
} from "@/lib/networking-workspace";
import { m } from "@/paraglide/messages";
import { importRuleSetPreset } from "@/query/networking";

import { NetworkingSection } from "./_modules/networking-badges";
import { networkingWriteReasonMessage } from "./_modules/networking-write-message";
import {
  useInvalidateNetworking,
  useNetworkingWorkspace,
} from "./_modules/use-networking-workspace";

export const Route = createFileRoute("/(admin)/admin/networking/rule-sets")({
  staticData: {
    crumb: () => m.admin_workspace_networking_rule_sets(),
  },
  component: RouteComponent,
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function RouteComponent(): React.ReactElement {
  const { data, isPending, isError, refetch } = useNetworkingWorkspace();
  const [importOpen, setImportOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] =
    useState<ManagedRuleSetPreset | null>(null);

  if (isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex flex-col gap-3 p-4 md:p-6">
        <p className="text-sm text-destructive">
          {m.admin_networking_load_error()}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {m.admin_networking_action_retry()}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageHeaderTitle>
            {m.admin_workspace_networking_rule_sets()}
          </PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_networking_rulesets_description()}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setSelectedPreset(null);
            setImportOpen(true);
          }}
        >
          <PlusIcon />
          {m.admin_networking_rulesets_import()}
        </Button>
      </PageHeader>

      {data.activationEnabled ? null : (
        <Alert variant="info">
          <AlertTitle>
            {m.admin_networking_activation_disabled_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_networking_activation_disabled_description()}
          </AlertDescription>
        </Alert>
      )}

      <NetworkingSection
        title={m.admin_networking_rulesets_presets_title()}
        description={m.admin_networking_rulesets_presets_description()}
      >
        <ul className="grid gap-3 md:grid-cols-2">
          {MANAGED_RULE_SET_PRESET_CATALOG.map((preset) => (
            <li
              key={preset.id}
              className="flex flex-col gap-2 rounded-lg border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">
                  {m[preset.nameKey]()}
                </span>
                <Badge variant="outline">{preset.suggestedVersion}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {m[preset.descriptionKey]()}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{preset.source}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectedPreset(preset);
                    setImportOpen(true);
                  }}
                >
                  <FileUpIcon />
                  {m.admin_networking_rulesets_attach()}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </NetworkingSection>

      <NetworkingSection
        title={m.admin_networking_rulesets_imported_title()}
        description={m.admin_networking_rulesets_budget()}
      >
        {data.ruleSets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.admin_networking_rulesets_empty()}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.ruleSets.map((ruleSet) => (
              <li
                key={`${ruleSet.ruleSetId}:${ruleSet.version}`}
                data-slot="rule-set-asset"
                className="flex flex-col gap-2 rounded-lg border bg-background p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {ruleSet.ruleSetId}
                  </span>
                  <Badge variant="outline">{ruleSet.version}</Badge>
                  <Badge variant="outline">{ruleSet.format}</Badge>
                  <span className="ms-auto text-xs text-muted-foreground">
                    {formatBytes(ruleSet.sizeBytes)}
                  </span>
                </div>
                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <span className="font-mono">
                    sha256:{ruleSet.sha256.slice(0, 16)}…
                  </span>
                  <span>{ruleSet.source}</span>
                  <span>
                    {m.admin_networking_rulesets_used_by({
                      count: ruleSet.usedByServerIds.length,
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </NetworkingSection>

      <RuleSetImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        preset={selectedPreset}
      />
    </div>
  );
}

function RuleSetImportDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: ManagedRuleSetPreset | null;
}): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const [ruleSetId, setRuleSetId] = useState("");
  const [version, setVersion] = useState("");
  const [source, setSource] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRuleSetId(preset?.id ?? "");
    setVersion(preset?.suggestedVersion ?? "");
    setSource(preset?.source ?? "");
    setFileName("");
    setContent("");
    setError(null);
  }, [open, preset]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > 512 * 1024) {
      setError(m.admin_networking_rulesets_file_too_large());
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setFileName(file.name);
    setContent(dataUrl.slice(dataUrl.indexOf(",") + 1));
  };

  const submit = useLockFn(async () => {
    setError(null);
    const result = await importRuleSetPreset({
      data: {
        ruleSetId: ruleSetId.trim(),
        version: version.trim(),
        source: source.trim(),
        contentBase64: content,
      },
    });
    if (!result.ok) {
      setError(networkingWriteReasonMessage(result.reason));
      return;
    }
    toastManager.add({
      type: "success",
      title: m.admin_networking_rulesets_toast_imported(),
    });
    await invalidate();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.admin_networking_rulesets_import()}</DialogTitle>
          <DialogDescription>
            {m.admin_networking_rulesets_import_description()}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }}
          >
            <Field>
              <FieldLabel>{m.admin_networking_rulesets_field_id()}</FieldLabel>
              <Input
                value={ruleSetId}
                onValueChange={setRuleSetId}
                maxLength={64}
                placeholder="geoip-cn"
              />
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_field_version()}
              </FieldLabel>
              <Input
                value={version}
                onValueChange={setVersion}
                maxLength={64}
              />
              <FieldDescription>
                {m.admin_networking_rulesets_field_version_hint()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_field_source()}
              </FieldLabel>
              <Input value={source} onValueChange={setSource} maxLength={512} />
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_field_file()}
              </FieldLabel>
              <Input
                type="file"
                accept=".srs,application/octet-stream"
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
              <FieldDescription>
                {fileName
                  ? m.admin_networking_rulesets_file_selected({
                      name: fileName,
                    })
                  : m.admin_networking_rulesets_file_hint()}
              </FieldDescription>
            </Field>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter variant="bare">
              <DialogClose render={<Button variant="outline" />}>
                {m.admin_networking_action_cancel()}
              </DialogClose>
              <Button type="submit">
                {m.admin_networking_action_create()}
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}
