import * as React from "react";
import { createCallable } from "react-call";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SubscriptionStatus } from "@/db/plan-schema";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

export interface EditSubscriptionProps {
  status: SubscriptionStatus;
  expiresAt: Date;
  onSave: (result: EditSubscriptionResult) => Promise<unknown>;
}

export interface EditSubscriptionResult {
  status: SubscriptionStatus;
  /** ISO string, as the server-fn boundary expects. */
  expiresAt: string;
}

const STATUS_OPTIONS: SubscriptionStatus[] = ["active", "expired", "cancelled"];

function statusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case "active":
      return m.admin_users_subs_status_active();
    case "expired":
      return m.admin_users_subs_status_expired();
    case "cancelled":
      return m.admin_users_subs_status_cancelled();
  }
}

/** Local wall-clock value for <input type="datetime-local">. */
function toLocalInputValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * Edits a subscription's status and expiry and keeps the dialog open while the
 * caller's mutation runs.
 */
export const EditSubscriptionDialog = createCallable<
  EditSubscriptionProps,
  void
>(({ call, status: initialStatus, expiresAt: initialExpiresAt, onSave }) => {
  const [status, setStatus] = React.useState<SubscriptionStatus>(initialStatus);
  const [expiresAt, setExpiresAt] = React.useState(() =>
    toLocalInputValue(new Date(initialExpiresAt)),
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const submit = async () => {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onSave({ status, expiresAt: parsed.toISOString() });
      call.end();
    } catch {
      // The mutation reports the error. Leave the dialog open for retrying.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={!call.ended}
      onOpenChange={(open) => {
        if (!open && !call.ended && !isSubmitting) {
          call.end();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.admin_users_subs_edit_title()}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6">
          <Field>
            <FieldLabel>{m.admin_users_subs_edit_field_status()}</FieldLabel>
            <Select
              items={STATUS_OPTIONS.map((option) => ({
                label: statusLabel(option),
                value: option,
              }))}
              value={status}
              onValueChange={(next) => setStatus(next as SubscriptionStatus)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {statusLabel(option)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{m.admin_users_subs_edit_field_expires()}</FieldLabel>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <DialogClose
            disabled={isSubmitting}
            render={<Button variant="ghost" />}
          >
            {m.admin_users_form_cancel()}
          </DialogClose>
          <Button loading={isSubmitting} onClick={() => void submit()}>
            {m.admin_users_subs_edit_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}, EXIT_MS);
