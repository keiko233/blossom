import * as React from "react";
import { createCallable } from "react-call";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

export interface BanUserResult {
  reason?: string;
  /** Days from now; undefined means a permanent ban. */
  expiresInDays?: number;
}

export interface BanUserDialogProps {
  onBan: (result: BanUserResult) => Promise<unknown>;
}

/**
 * Collects ban parameters and keeps the dialog open while the caller's
 * mutation runs.
 */
export const BanUserDialog = createCallable<BanUserDialogProps, void>(
  ({ call, onBan }) => {
    const [reason, setReason] = React.useState("");
    const [days, setDays] = React.useState(0);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const submit = async () => {
      setIsSubmitting(true);
      try {
        await onBan({
          reason: reason.trim() || undefined,
          expiresInDays: days > 0 ? days : undefined,
        });
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
            <DialogTitle>{m.admin_users_ban_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_users_ban_description()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6">
            <Field>
              <FieldLabel>{m.admin_users_ban_field_reason()}</FieldLabel>
              <Input value={reason} onValueChange={(v) => setReason(v)} />
            </Field>
            <Field>
              <FieldLabel>{m.admin_users_ban_field_days()}</FieldLabel>
              <NumberField
                min={0}
                value={days}
                onValueChange={(v) => setDays(v ?? 0)}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </Field>
          </div>
          <DialogFooter>
            <DialogClose
              disabled={isSubmitting}
              render={<Button variant="ghost" />}
            >
              {m.admin_users_form_cancel()}
            </DialogClose>
            <Button
              loading={isSubmitting}
              variant="destructive"
              onClick={() => void submit()}
            >
              {m.admin_users_ban_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
