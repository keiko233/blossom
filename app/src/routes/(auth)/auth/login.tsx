import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import GithubLine from "~icons/mingcute/github-line";
import GoogleLine from "~icons/mingcute/google-line";
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
import { Separator } from "@/components/ui/separator";
import { toastManager } from "@/components/ui/toast";
import { useLockFn } from "@/hooks/use-lock-fn";
import { emailSignIn, getSocialProviders } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { emailSignInSchema } from "@/lib/auth-schema";
import { m } from "@/paraglide/messages";

function useOAuthCallback(): string {
  const search = typeof window !== "undefined" ? window.location.search : "";
  if (!search.includes("client_id=")) return "/dashboard";
  return `/api/auth/oauth2/authorize${search}`;
}

export const Route = createFileRoute("/(auth)/auth/login")({
  beforeLoad: async () => {
    const socialProviders = await getSocialProviders();

    return {
      socialProviders,
    };
  },
  component: RouteComponent,
});

const SignInWithGithubButton = () => {
  const [isPending, setIsPending] = useState(false);
  const callbackURL = useOAuthCallback();

  const handleClick = useLockFn(async () => {
    setIsPending(true);
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL,
      });
    } catch (error) {
      console.error(error);
      setIsPending(false);
    }
  });

  return (
    <Button variant="secondary" onClick={handleClick} loading={isPending}>
      <GithubLine className="shrink-0" />

      <span>{m.auth_sign_in_with_github()}</span>
    </Button>
  );
};

const SignInWithGoogleButton = () => {
  const [isPending, setIsPending] = useState(false);
  const callbackURL = useOAuthCallback();

  const handleClick = useLockFn(async () => {
    setIsPending(true);
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL,
      });
    } catch (error) {
      console.error(error);
      setIsPending(false);
    }
  });

  return (
    <Button variant="secondary" onClick={handleClick} loading={isPending}>
      <GoogleLine className="shrink-0" />

      <span>{m.auth_sign_in_with_google()}</span>
    </Button>
  );
};

function RouteComponent() {
  const { socialProviders } = Route.useRouteContext();

  const navigate = useNavigate();
  const callbackURL = useOAuthCallback();

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    validators: {
      onSubmit: emailSignInSchema,
    },
    onSubmit: async ({ value }) => {
      try {
        const result = await emailSignIn({
          data: {
            ...value,
            callbackURL,
          },
        });

        if (result) {
          if (callbackURL.startsWith("/api/auth/oauth2/authorize")) {
            window.location.assign(callbackURL);
          } else {
            await navigate({
              to: "/dashboard",
            });
          }
        }
      } catch {
        toastManager.add({
          type: "error",
          title: m.auth_login_error_title(),
          description: m.auth_login_error_description(),
        });
      }
    },
  });

  return (
    <Card className="w-full max-w-xs">
      <CardHeader>
        <CardTitle>{m.auth_title()}</CardTitle>
        <CardDescription>{m.auth_description()}</CardDescription>
      </CardHeader>

      <CardPanel className="flex flex-col gap-4">
        {socialProviders.github && <SignInWithGithubButton />}

        {socialProviders.google && <SignInWithGoogleButton />}

        <Separator />

        <Form form={form} className="flex w-full flex-col gap-4">
          <FormField name="email">
            <FieldLabel>{m.auth_login_label_email()}</FieldLabel>

            <FieldControl
              render={
                <Input placeholder={m.auth_login_label_email()} type="text" />
              }
            />

            <FieldError />
          </FormField>

          <FormField name="password">
            <FieldLabel className="flex w-full justify-between">
              {m.auth_login_label_password()}
              <Link
                className="text-xs text-muted-foreground underline"
                to="/auth/forgot"
              >
                {m.auth_login_forgot_password()}
              </Link>
            </FieldLabel>

            <FieldControl
              render={
                <Input
                  placeholder={m.auth_login_label_password()}
                  type="password"
                />
              }
            />

            <FieldError />
          </FormField>

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button className="w-full" type="submit" loading={isSubmitting}>
                {m.auth_login_button()}
              </Button>
            )}
          </form.Subscribe>
        </Form>
      </CardPanel>

      <CardFooter>
        <div className="flex gap-1 text-xs text-muted-foreground">
          <InformationLine className="size-3 h-lh shrink-0" />
          <Link className="underline" to="/auth/signup">
            {m.auth_login_to_signup()}
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}
