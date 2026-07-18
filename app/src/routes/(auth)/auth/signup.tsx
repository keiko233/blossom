import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link } from "@tanstack/react-router";
import InformationLine from "~icons/mingcute/information-line";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import {
  FieldControl,
  FieldError,
  FieldLabel,
  FormField,
} from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { emailSignUp } from "@/lib/auth";
import { emailSignUpSchema } from "@/lib/auth-schema";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(auth)/auth/signup")({
  component: RouteComponent,
});

function RouteComponent() {
  const form = useForm({
    defaultValues: {
      email: "",
    },
    validators: {
      onSubmit: emailSignUpSchema,
    },
    onSubmit: async ({ value }) => {
      try {
        const result = await emailSignUp({ data: value });

        if (result) {
          toastManager.add({
            type: "success",
            title: m.auth_signup_mail_sent_title(),
            description: m.auth_signup_mail_sent_description(),
          });
        }
      } catch {}
    },
  });

  return (
    <Card className="w-full max-w-xs">
      <CardHeader>
        <CardTitle>{m.auth_signup_title()}</CardTitle>
        <CardDescription>{m.auth_signup_description()}</CardDescription>
      </CardHeader>

      <CardPanel className="flex flex-col gap-4">
        <Form form={form} className="flex w-full flex-col gap-4">
          <FormField name="email">
            <FieldLabel>{m.auth_signup_label_email()}</FieldLabel>

            <FieldControl
              render={
                <Input placeholder={m.auth_signup_label_email()} type="text" />
              }
            />

            <FieldError />
          </FormField>

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button className="w-full" type="submit" loading={isSubmitting}>
                {m.auth_signup_button()}
              </Button>
            )}
          </form.Subscribe>
        </Form>
      </CardPanel>

      <CardFooter>
        <div className="flex gap-1 text-xs text-muted-foreground">
          <InformationLine className="size-3 h-lh shrink-0" />
          <Link className="underline" to="/auth/login">
            {m.auth_signup_to_login()}
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}
