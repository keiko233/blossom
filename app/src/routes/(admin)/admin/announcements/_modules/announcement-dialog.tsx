import { useQuery } from "@tanstack/react-query";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_LEVELS,
  type AnnouncementAudience,
  type AnnouncementLevel,
} from "@/db/announcement-schema";
import { m } from "@/paraglide/messages";
import type { AnnouncementListItem } from "@/query/announcements";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

import { AUDIENCE_LABELS, LEVEL_LABELS } from "./announcement-labels";
import { useAnnouncementForm } from "./use-announcement-form";

const FORM_ID = "announcement-form";

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

export interface AnnouncementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing; absent for create. */
  announcement?: AnnouncementListItem;
}

/**
 * Create/edit dialog. The form lives in `AnnouncementForm`, which Base UI only
 * mounts while the popup is open, so every open starts from fresh values.
 */
export function AnnouncementDialog({
  open,
  onOpenChange,
  announcement,
}: AnnouncementDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <AnnouncementForm
          announcement={announcement}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function AnnouncementForm({
  announcement,
  onDone,
}: {
  announcement?: AnnouncementListItem;
  onDone: () => void;
}): React.ReactElement {
  const { form, isEdit } = useAnnouncementForm({
    announcement,
    onSuccess: onDone,
  });

  const { data: plans } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? m.admin_announcements_form_edit_title()
            : m.admin_announcements_form_create_title()}
        </DialogTitle>
        <DialogDescription>
          {m.admin_announcements_form_description()}
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
          <form.Field name="title">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_announcements_field_title()}</FieldLabel>
                <Input
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v)}
                  onBlur={field.handleBlur}
                />
                <FieldErrors errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>

          <form.Field name="body">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_announcements_field_body()}</FieldLabel>
                <Textarea
                  rows={6}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                <FieldDescription>
                  {m.admin_announcements_field_body_hint()}
                </FieldDescription>
                <FieldErrors errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>

          <form.Field name="level">
            {(field) => (
              <Field>
                <FieldLabel>{m.admin_announcements_field_level()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) =>
                    v && field.handleChange(v as AnnouncementLevel)
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(v: AnnouncementLevel) => LEVEL_LABELS[v]()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {ANNOUNCEMENT_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {LEVEL_LABELS[level]()}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            )}
          </form.Field>

          <form.Field name="audience">
            {(field) => (
              <Field>
                <FieldLabel>
                  {m.admin_announcements_field_audience()}
                </FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) =>
                    v && field.handleChange(v as AnnouncementAudience)
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(v: AnnouncementAudience) => AUDIENCE_LABELS[v]()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {ANNOUNCEMENT_AUDIENCES.map((audience) => (
                      <SelectItem key={audience} value={audience}>
                        {AUDIENCE_LABELS[audience]()}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            )}
          </form.Field>

          <form.Subscribe selector={(s) => s.values.audience}>
            {(audience) =>
              audience === "plan" ? (
                <form.Field name="planIds">
                  {(field) => (
                    <Field>
                      <FieldLabel>
                        {m.admin_announcements_field_plans()}
                      </FieldLabel>
                      {plans && plans.length > 0 ? (
                        <div className="flex flex-col gap-2">
                          {plans.map((plan) => (
                            <label
                              key={plan.id}
                              className="flex items-center gap-2 text-sm"
                            >
                              <Checkbox
                                checked={field.state.value.includes(plan.id)}
                                onCheckedChange={(checked) =>
                                  field.handleChange(
                                    checked
                                      ? [...field.state.value, plan.id]
                                      : field.state.value.filter(
                                          (id) => id !== plan.id,
                                        ),
                                  )
                                }
                              />
                              {plan.name}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <FieldDescription>
                          {m.admin_announcements_plans_empty()}
                        </FieldDescription>
                      )}
                      <FieldDescription>
                        {m.admin_announcements_field_plans_hint()}
                      </FieldDescription>
                      <FieldErrors errors={field.state.meta.errors} />
                    </Field>
                  )}
                </form.Field>
              ) : null
            }
          </form.Subscribe>

          <form.Field name="pinned">
            {(field) => (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(v) => field.handleChange(v)}
                  />
                  <Label>{m.admin_announcements_field_pinned()}</Label>
                </div>
                <FieldDescription>
                  {m.admin_announcements_field_pinned_hint()}
                </FieldDescription>
              </div>
            )}
          </form.Field>

          <form.Field name="published">
            {(field) => (
              <div className="flex items-center gap-3">
                <Switch
                  checked={field.state.value}
                  onCheckedChange={(v) => field.handleChange(v)}
                />
                <Label>{m.admin_announcements_field_published()}</Label>
              </div>
            )}
          </form.Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <form.Field name="startsAt">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_announcements_field_starts_at()}
                  </FieldLabel>
                  <Input
                    type="datetime-local"
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="endsAt">
              {(field) => (
                <Field>
                  <FieldLabel>
                    {m.admin_announcements_field_ends_at()}
                  </FieldLabel>
                  <Input
                    type="datetime-local"
                    value={field.state.value}
                    onValueChange={(v) => field.handleChange(v)}
                    onBlur={field.handleBlur}
                  />
                  <FieldErrors errors={field.state.meta.errors} />
                </Field>
              )}
            </form.Field>
          </div>
          <FieldDescription>
            {m.admin_announcements_field_schedule_hint()}
          </FieldDescription>
        </form>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {m.admin_announcements_form_cancel()}
        </DialogClose>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" form={FORM_ID} loading={isSubmitting}>
              {m.admin_announcements_form_save()}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </>
  );
}
