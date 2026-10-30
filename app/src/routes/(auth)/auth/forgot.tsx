import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(auth)/auth/forgot")({
  component: RouteComponent,
});

function RouteComponent() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setState("idle");
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: "/auth/reset",
      });
      setState(result.error ? "error" : "sent");
    } catch {
      setState("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-xs">
      <CardHeader>
        <CardTitle>{m.auth_forgot_title()}</CardTitle>
        <CardDescription>{m.auth_forgot_description()}</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        {state === "sent" && (
          <Alert variant="success">
            <AlertDescription>{m.auth_forgot_sent()}</AlertDescription>
          </Alert>
        )}
        {state === "error" && (
          <Alert variant="error">
            <AlertDescription>{m.auth_forgot_error()}</AlertDescription>
          </Alert>
        )}
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recovery-email">{m.auth_login_label_email()}</Label>
            <Input
              id="recovery-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" loading={pending} disabled={pending}>
            {m.auth_forgot_submit()}
          </Button>
        </form>
      </CardPanel>
      <CardFooter>
        <Link className="text-xs underline" to="/auth/login">
          {m.auth_forgot_back()}
        </Link>
      </CardFooter>
    </Card>
  );
}
