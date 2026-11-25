import type React from "react";
import { useEffect, useState } from "react";

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
import { toastManager } from "@/components/ui/toast";
import { useLockFn } from "@/hooks/use-lock-fn";
import { m } from "@/paraglide/messages";
import { importRuleSetPreset } from "@/query/networking";

import { networkingWriteReasonMessage } from "./networking-write-message";
import { useInvalidateNetworking } from "./use-networking-workspace";

const SRS_MAGIC = [0x53, 0x52, 0x53] as const;

function hasSrsMagic(base64: string): boolean {
  try {
    const binary = atob(base64);
    return (
      binary.length >= SRS_MAGIC.length &&
      SRS_MAGIC.every((byte, index) => binary.charCodeAt(index) === byte)
    );
  } catch {
    return false;
  }
}

export interface RuleSetUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: {
    id: string;
    suggestedVersion: string;
    source: string;
  } | null;
  onUploaded: () => Promise<void> | void;
}

export function RuleSetUploadDialog({
  open,
  onOpenChange,
  preset,
  onUploaded,
}: RuleSetUploadDialogProps): React.ReactElement {
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
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (!hasSrsMagic(base64)) {
      setFileName(file.name);
      setContent("");
      setError(m.admin_networking_rulesets_upload_invalid_magic());
      return;
    }
    setFileName(file.name);
    setContent(base64);
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
    await onUploaded();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {m.admin_networking_rulesets_upload_title()}
          </DialogTitle>
          <DialogDescription>
            {m.admin_networking_rulesets_upload_description()}
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
                maxLength={64}
                onValueChange={setRuleSetId}
                placeholder="geoip-cn"
                value={ruleSetId}
              />
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_field_version()}
              </FieldLabel>
              <Input
                maxLength={64}
                onValueChange={setVersion}
                value={version}
              />
              <FieldDescription>
                {m.admin_networking_rulesets_field_version_hint()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_field_source()}
              </FieldLabel>
              <Input maxLength={512} onValueChange={setSource} value={source} />
            </Field>
            <Field>
              <FieldLabel>
                {m.admin_networking_rulesets_field_file()}
              </FieldLabel>
              <Input
                accept=".srs,application/octet-stream"
                onChange={(event) => void readFile(event.target.files?.[0])}
                type="file"
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
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <DialogFooter variant="bare">
              <DialogClose render={<Button variant="outline" />}>
                {m.admin_networking_action_cancel()}
              </DialogClose>
              <Button disabled={!content} type="submit">
                {m.admin_networking_action_create()}
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}
