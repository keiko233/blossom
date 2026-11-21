import type React from "react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  RULE_ACTIONS,
  RULE_MATCH_TYPES,
  RULE_SCOPES,
  type RuleAction,
  type RuleMatchType,
  type RuleScope,
} from "@/db/rule-schema";
import { isServerScope } from "@/lib/routing-rules";
import { m } from "@/paraglide/messages";
import type { RuleListItem } from "@/query/rules";

import { ACTION_LABELS, MATCH_TYPE_LABELS, SCOPE_LABELS } from "./rule-labels";
import { useRuleForm } from "./use-rule-form";

const FORM_ID = "rule-form";

function FieldErrors({ errors }: { errors: readonly unknown[] }) {
  const message = errors
    .map((error) =>
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "",
    )
    .filter(Boolean)
    .join(", ");
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

export interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing; absent for create. */
  rule?: RuleListItem;
}

/**
 * Create/edit dialog. The form lives in `RuleForm`, which Base UI only mounts
 * while the popup is open, so every open starts from fresh default values.
 */
export function RuleDialog({
  open,
  onOpenChange,
  rule,
}: RuleDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <RuleForm rule={rule} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RuleForm({
  rule,
  onDone,
}: {
  rule?: RuleListItem;
  onDone: () => void;
}): React.ReactElement {
  const { form, isEdit } = useRuleForm({ rule, onSuccess: onDone });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? m.admin_rules_form_edit_title()
            : m.admin_rules_form_create_title()}
        </DialogTitle>
        <DialogDescription>
          {m.admin_rules_form_description()}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <form
          id={FORM_ID}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_rules_field_name()}</FieldLabel>
                <Input
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v)}
                  onBlur={field.handleBlur}
                />
                <FieldErrors errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>

          <form.Field name="matchType">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_rules_field_match_type()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) =>
                    v && field.handleChange(v as RuleMatchType)
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(v: RuleMatchType) => MATCH_TYPE_LABELS[v]()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {RULE_MATCH_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {MATCH_TYPE_LABELS[type]()}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            )}
          </form.Field>

          <form.Field name="valuesText">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_rules_field_values()}</FieldLabel>
                <form.Subscribe selector={(s) => s.values.matchType}>
                  {(matchType) => (
                    <Textarea
                      className="font-mono"
                      rows={6}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder={
                        matchType === "ip_cidr"
                          ? m.admin_rules_field_values_placeholder_cidr()
                          : m.admin_rules_field_values_placeholder_domain()
                      }
                    />
                  )}
                </form.Subscribe>
                <FieldDescription>
                  {m.admin_rules_field_values_hint()}
                </FieldDescription>
                <FieldErrors errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>

          <form.Field name="scope">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_rules_field_scope()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) => {
                    if (!v) return;
                    const scope = v as RuleScope;
                    field.handleChange(scope);
                    // Server-side rules can only reject: force and lock it.
                    if (isServerScope(scope)) {
                      form.setFieldValue("action", "reject");
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(v: RuleScope) => SCOPE_LABELS[v]()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {RULE_SCOPES.map((scope) => (
                      <SelectItem key={scope} value={scope}>
                        {SCOPE_LABELS[scope]()}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>
                  {m.admin_rules_field_scope_hint()}
                </FieldDescription>
              </Field>
            )}
          </form.Field>

          <form.Field name="action">
            {(field) => (
              <form.Subscribe selector={(s) => isServerScope(s.values.scope)}>
                {(locked) => (
                  <Field>
                    <FieldLabel>{m.admin_rules_field_action()}</FieldLabel>
                    <Select
                      disabled={locked}
                      value={field.state.value}
                      onValueChange={(v) =>
                        v && field.handleChange(v as RuleAction)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue>
                          {(v: RuleAction) => ACTION_LABELS[v]()}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {RULE_ACTIONS.map((action) => (
                          <SelectItem key={action} value={action}>
                            {ACTION_LABELS[action]()}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {locked ? (
                      <FieldDescription>
                        {m.admin_rules_field_action_locked()}
                      </FieldDescription>
                    ) : null}
                  </Field>
                )}
              </form.Subscribe>
            )}
          </form.Field>

          <form.Field name="enabled">
            {(field) => (
              <div className="flex items-center gap-3">
                <Switch
                  checked={field.state.value}
                  onCheckedChange={(v) => field.handleChange(v)}
                />
                <Label>{m.admin_rules_field_enabled()}</Label>
              </div>
            )}
          </form.Field>
        </form>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {m.admin_rules_form_cancel()}
        </DialogClose>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" form={FORM_ID} loading={isSubmitting}>
              {m.admin_rules_form_save()}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </>
  );
}
