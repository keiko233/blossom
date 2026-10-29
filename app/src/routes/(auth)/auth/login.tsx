import { useForm } from "@tanstack/react-form";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import GithubLine from "~icons/mingcute/github-line";
import GoogleLine from "~icons/mingcute/google-line";
import InformationLine from "~icons/mingcute/information-line";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { registrationReasonFromErrorCode } from "@/lib/registration-policy";
import { m } from "@/paraglide/messages";
import { getPublicSettings } from "@/query/settings";

function useOAuthCallback(): string {
  const search = typeof window !== "undefined" ? window.location.search : "";
  if (!search.includes("client_id=")) return "/dashboard";
  return `/api/auth/oauth2/authorize${search}`;
}

/**
 * Why a redirect back to this page failed (`?error=<code>`), as text. Read
 * after mount from the URL: the page also receives OAuth parameters that a
 * router-level search schema would strip. Null when there is no error.
 */
function useRedirectError(): string | null {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get("error"));
  }, []);

  if (!code) return null;
  switch (registrationReasonFromErrorCode(code)) {
    case "closed":
      return m.auth_signup_closed_description();
    case "domain_not_allowed":
      return m.auth_signup_domain_not_allowed_description();
    default:
      return m.auth_redirect_error();
  }
}

export const Route = createFileRoute("/(auth)/auth/login")({
  beforeLoad: async () => {
    const [socialProviders, publicSettings] = await Promise.all([
      getSocialProviders(),
      getPublicSettings(),
    ]);

    return {
      socialProviders,
      registrationMode: publicSettings.registrationMode,
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
        errorCallbackURL: "/auth/login",
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
        errorCallbackURL: "/auth/login",
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
  const { socialProviders, registrationMode } = Route.useRouteContext();
  const redirectError = useRedirectError();

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
      } catch (error) {
        const unverified =
          error instanceof Error && /not verified/i.test(error.message);
        toastManager.add({
          type: "error",
          title: m.auth_login_error_title(),
          description: unverified
            ? m.auth_login_error_unverified()
            : m.auth_login_error_description(),
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
        {redirectError ? (
          <Alert variant="error">
            <AlertDescription>{redirectError}</AlertDescription>
          </Alert>
        ) : null}

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
          {registrationMode === "closed" ? (
            <span>{m.auth_login_registration_closed()}</span>
          ) : (
            <Link className="underline" to="/auth/signup">
              {m.auth_login_to_signup()}
            </Link>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
