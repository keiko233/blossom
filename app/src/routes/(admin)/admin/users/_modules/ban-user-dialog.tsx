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

/**
 * Collects ban parameters: resolves with reason/duration or null when
 * dismissed. The caller runs the mutation.
 */
export const BanUserDialog = createCallable<void, BanUserResult | null>(
  ({ call }) => {
    const [reason, setReason] = React.useState("");
    const [days, setDays] = React.useState(0);

    const submit = () =>
      call.end({
        reason: reason.trim() || undefined,
        expiresInDays: days > 0 ? days : undefined,
      });

    return (
      <Dialog
        open={!call.ended}
        onOpenChange={(open) => {
          if (!open && !call.ended) {
            call.end(null);
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
            <DialogClose render={<Button variant="ghost" />}>
              {m.admin_users_form_cancel()}
            </DialogClose>
            <Button variant="destructive" onClick={submit}>
              {m.admin_users_ban_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
