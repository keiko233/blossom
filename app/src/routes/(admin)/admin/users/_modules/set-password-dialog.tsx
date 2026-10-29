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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { setUserPasswordSchema } from "@/orpc/user/schema";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

export interface SetPasswordDialogProps {
  onSubmit: (password: string) => Promise<unknown>;
}

/** Collects a new password and stays open until the request settles. */
export const SetPasswordDialog = createCallable<SetPasswordDialogProps, void>(
  ({ call, onSubmit }) => {
    const [password, setPassword] = React.useState("");
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const parsed = setUserPasswordSchema.safeParse({ id: "-", password });

    const submit = async () => {
      if (!parsed.success) return;
      setIsSubmitting(true);
      try {
        await onSubmit(parsed.data.password);
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
            <DialogTitle>{m.admin_users_password_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_users_password_description()}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6">
            <Field>
              <FieldLabel>{m.admin_users_password_field()}</FieldLabel>
              <Input
                autoComplete="new-password"
                type="password"
                value={password}
                onValueChange={(v) => setPassword(v)}
              />
              <FieldDescription>
                {m.admin_users_password_hint()}
              </FieldDescription>
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
              disabled={!parsed.success}
              loading={isSubmitting}
              onClick={() => void submit()}
            >
              {m.admin_users_password_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
