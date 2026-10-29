import * as React from "react";
import { createCallable } from "react-call";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { updateUserSchema } from "@/orpc/user/schema";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

export interface EditUserResult {
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface EditUserDialogProps {
  user: EditUserResult;
  onSave: (result: EditUserResult) => Promise<unknown>;
}

/** Name, email and verified flag; stays open until the save settles. */
export const EditUserDialog = createCallable<EditUserDialogProps, void>(
  ({ call, user, onSave }) => {
    const [name, setName] = React.useState(user.name);
    const [email, setEmail] = React.useState(user.email);
    const [emailVerified, setEmailVerified] = React.useState(
      user.emailVerified,
    );
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    // The id isn't edited here; the schema is only used to validate the rest.
    const parsed = updateUserSchema.safeParse({
      id: "-",
      name,
      email,
      emailVerified,
    });

    const submit = async () => {
      if (!parsed.success) return;
      setIsSubmitting(true);
      try {
        await onSave({
          name: parsed.data.name,
          email: parsed.data.email,
          emailVerified: parsed.data.emailVerified,
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
            <DialogTitle>{m.admin_users_edit_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_users_edit_description()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6">
            <Field>
              <FieldLabel>{m.admin_users_field_name()}</FieldLabel>
              <Input value={name} onValueChange={(v) => setName(v)} />
            </Field>
            <Field>
              <FieldLabel>{m.admin_users_field_email()}</FieldLabel>
              <Input
                type="email"
                value={email}
                onValueChange={(v) => setEmail(v)}
              />
            </Field>
            <Field>
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={emailVerified}
                  onCheckedChange={(checked) => setEmailVerified(checked)}
                />
                {m.admin_users_edit_field_verified()}
              </label>
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
              {m.admin_users_edit_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
