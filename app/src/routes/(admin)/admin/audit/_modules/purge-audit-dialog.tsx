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
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
} from "@/orpc/audit/schema";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

export interface PurgeAuditDialogProps {
  onPurge: (olderThanDays: number) => Promise<unknown>;
}

/**
 * Retention control: asks how old an entry must be to be deleted (default 180
 * days) and keeps the dialog open while the purge runs. The destructive
 * button is the confirmation.
 */
export const PurgeAuditDialog = createCallable<PurgeAuditDialogProps, void>(
  ({ call, onPurge }) => {
    const [days, setDays] = React.useState(AUDIT_RETENTION_DEFAULT_DAYS);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const submit = async () => {
      setIsSubmitting(true);
      try {
        await onPurge(days);
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
            <DialogTitle>{m.admin_audit_purge_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_audit_purge_description({ days })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6">
            <Field>
              <FieldLabel>{m.admin_audit_purge_field_days()}</FieldLabel>
              <NumberField
                max={AUDIT_RETENTION_MAX_DAYS}
                min={AUDIT_RETENTION_MIN_DAYS}
                value={days}
                onValueChange={(v) =>
                  setDays(v ?? AUDIT_RETENTION_DEFAULT_DAYS)
                }
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
              {m.admin_audit_purge_cancel()}
            </DialogClose>
            <Button
              loading={isSubmitting}
              variant="destructive"
              onClick={() => void submit()}
            >
              {m.admin_audit_purge_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
