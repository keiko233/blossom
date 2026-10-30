import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";

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

export const Route = createFileRoute("/(auth)/auth/reset")({
  component: RouteComponent,
});

function RouteComponent() {
  const [token, setToken] = useState<string | null>(null);
  const tokenRead = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"idle" | "done" | "error" | "mismatch">(
    "idle",
  );

  useEffect(() => {
    if (tokenRead.current) return;
    tokenRead.current = true;
    const url = new URL(window.location.href);
    setToken(url.searchParams.get("token"));
    url.searchParams.delete("token");
    url.searchParams.delete("error");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
    setLoaded(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirmation) {
      setState("mismatch");
      return;
    }
    setPending(true);
    setState("idle");
    try {
      const result = await authClient.resetPassword({
        token,
        newPassword: password,
      });
      setState(result.error ? "error" : "done");
      if (!result.error) {
        setToken(null);
        setPassword("");
        setConfirmation("");
      }
    } catch {
      setState("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-xs">
      <CardHeader>
        <CardTitle>{m.auth_reset_title()}</CardTitle>
        <CardDescription>{m.auth_reset_description()}</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        {state === "done" && (
          <Alert variant="success">
            <AlertDescription>{m.auth_reset_done()}</AlertDescription>
          </Alert>
        )}
        {loaded && state !== "done" && (!token || state === "error") && (
          <Alert variant="error">
            <AlertDescription>{m.auth_reset_error()}</AlertDescription>
          </Alert>
        )}
        {state === "mismatch" && (
          <Alert variant="error">
            <AlertDescription>{m.auth_reset_mismatch()}</AlertDescription>
          </Alert>
        )}
        {loaded && token && state !== "done" && (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password">{m.auth_reset_password()}</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password">{m.auth_reset_confirm()}</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
            <Button type="submit" loading={pending} disabled={pending}>
              {m.auth_reset_submit()}
            </Button>
          </form>
        )}
      </CardPanel>
      <CardFooter>
        <Link
          className="text-xs underline"
          to={state === "done" ? "/auth/login" : "/auth/forgot"}
        >
          {state === "done"
            ? m.auth_forgot_back()
            : m.auth_reset_request_again()}
        </Link>
      </CardFooter>
    </Card>
  );
}
