import { useQuery } from "@tanstack/react-query";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createUserSchema } from "@/orpc/user/schema";
import type { CreateUserInput } from "@/orpc/user/schema";
import { m } from "@/paraglide/messages";
import { listPlans, PLANS_QUERY_KEY } from "@/query/plans";

const EXIT_MS = 200;
/** Sentinel for "no plan"; Select values cannot be null with a label. */
const NO_PLAN = "none";

const ROLES = ["user", "admin"] as const;

function roleLabel(role: (typeof ROLES)[number]): string {
  return role === "admin"
    ? m.admin_users_role_admin()
    : m.admin_users_role_user();
}

export interface CreateUserDialogProps {
  /** Runs the mutation; the dialog stays open and loading until it settles. */
  onCreate: (input: CreateUserInput) => Promise<unknown>;
}

/**
 * Account creation form. A blank password creates the account without one and
 * unlocks the "email a sign-in link" option; a plan assigns a subscription
 * right away.
 */
export const CreateUserDialog = createCallable<CreateUserDialogProps, void>(
  ({ call, onCreate }) => {
    const [name, setName] = React.useState("");
    const [email, setEmail] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [role, setRole] = React.useState<(typeof ROLES)[number]>("user");
    const [planId, setPlanId] = React.useState(NO_PLAN);
    const [sendSignInLink, setSendSignInLink] = React.useState(false);
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    const { data: plans } = useQuery({
      queryKey: PLANS_QUERY_KEY,
      queryFn: () => listPlans(),
    });

    const hasPassword = password.length > 0;
    const parsed = createUserSchema.safeParse({
      name,
      email,
      password: hasPassword ? password : undefined,
      role,
      planId: planId === NO_PLAN ? undefined : planId,
      sendSignInLink: !hasPassword && sendSignInLink,
    });

    const submit = async () => {
      if (!parsed.success) return;
      setIsSubmitting(true);
      try {
        await onCreate(parsed.data);
        call.end();
      } catch {
        // The mutation reports the error. Leave the dialog open for retrying.
      } finally {
        setIsSubmitting(false);
      }
    };

    const planItems = [
      { label: m.admin_users_create_field_plan_none(), value: NO_PLAN },
      ...(plans ?? []).map((plan) => ({ label: plan.name, value: plan.id })),
    ];

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
            <DialogTitle>{m.admin_users_create_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_users_create_description()}
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
              <FieldLabel>{m.admin_users_create_field_password()}</FieldLabel>
              <Input
                autoComplete="new-password"
                type="password"
                value={password}
                onValueChange={(v) => setPassword(v)}
              />
              <FieldDescription>
                {m.admin_users_create_field_password_hint()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{m.admin_users_col_role()}</FieldLabel>
              <Select
                items={ROLES.map((value) => ({
                  label: roleLabel(value),
                  value,
                }))}
                value={role}
                onValueChange={(next) =>
                  setRole(next as (typeof ROLES)[number])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {ROLES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {roleLabel(value)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{m.admin_users_create_field_plan()}</FieldLabel>
              <Select
                items={planItems}
                value={planId}
                onValueChange={(next) => setPlanId(next as string)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {planItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {hasPassword ? null : (
              <Field>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={sendSignInLink}
                    onCheckedChange={(checked) => setSendSignInLink(checked)}
                  />
                  {m.admin_users_create_field_send_link()}
                </label>
                <FieldDescription>
                  {m.admin_users_create_field_send_link_hint()}
                </FieldDescription>
              </Field>
            )}
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
              {m.admin_users_create_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
