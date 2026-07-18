import { createFileRoute, redirect } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import { getSession } from "@/lib/auth";
import { isLoopbackUrl } from "@/lib/oauth-callback";

export const Route = createFileRoute("/(auth)/auth/mcp-consent")({
  beforeLoad: async () => {
    const session = await getSession();

    if (!session) {
      throw redirect({ to: "/auth/login" });
    }

    if (session.user.role !== "admin" || session.user.banned) {
      throw redirect({ to: "/dashboard" });
    }

    return { session };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const [pendingDecision, setPendingDecision] = useState<boolean | null>(null);
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const oauthQuery =
    typeof window !== "undefined" ? window.location.search.slice(1) : "";

  const handleDecision = async (accept: boolean) => {
    setPendingDecision(accept);
    setErrorMessage(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accept,
          oauth_query: oauthQuery,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message ?? "Consent failed");
      }

      const data: unknown = await response.json();
      const redirectUri = getRedirectUri(data);
      if (!redirectUri) {
        throw new Error(
          "Authorization response did not include a callback URL",
        );
      }

      if (accept && isLoopbackUrl(redirectUri)) {
        setCallbackUrl(redirectUri);
        setPendingDecision(null);
        return;
      }
      window.location.href = redirectUri;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Authorization failed",
      );
      setPendingDecision(null);
    }
  };

  const copyCallbackUrl = async () => {
    if (!callbackUrl) return;
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
    } catch {
      setErrorMessage("Could not copy the callback URL");
    } finally {
      setIsCopying(false);
    }
  };

  if (callbackUrl) {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Authorization approved</CardTitle>
          <CardDescription>
            The OAuth callback points to a loopback address. If your agent is
            running on another machine, copy the complete URL below and paste it
            into the agent terminal.
          </CardDescription>
        </CardHeader>

        <CardPanel className="flex flex-col gap-4">
          <code className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs break-all">
            {callbackUrl}
          </code>

          {errorMessage ? (
            <p className="text-sm text-destructive-foreground">
              {errorMessage}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="flex-1"
              loading={isCopying}
              onClick={() => void copyCallbackUrl()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Callback URL copied" : "Copy callback URL"}
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                window.location.href = callbackUrl;
              }}
              variant="secondary"
            >
              <ExternalLinkIcon />
              Open callback URL
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Treat this URL as a one-time credential. Do not share or store it.
          </p>
        </CardPanel>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>MCP Authorization</CardTitle>
        <CardDescription>
          An application is requesting access to your Blossom MCP server. Only
          administrators may grant MCP access.
        </CardDescription>
      </CardHeader>

      <CardPanel className="flex flex-col gap-4">
        <div className="space-y-2 text-sm">
          <p>
            <strong>Scopes this server can grant:</strong>
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <code>blossom:mcp:read</code> — read access to admin data
            </li>
            <li>
              <code>blossom:mcp:write</code> — write access to admin data
            </li>
            <li>
              <code>offline_access</code> — keep the agent connected by
              refreshing expired access tokens
            </li>
          </ul>
        </div>

        <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          Remote OAuth is supported. When the agent uses a loopback callback,
          Blossom will show the final callback URL after approval so you can
          copy it back to the remote terminal.
        </p>

        {errorMessage ? (
          <p className="text-sm text-destructive-foreground">{errorMessage}</p>
        ) : null}

        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => handleDecision(true)}
            disabled={pendingDecision !== null}
            loading={pendingDecision === true}
          >
            Approve
          </Button>
          <Button
            className="flex-1"
            variant="secondary"
            onClick={() => handleDecision(false)}
            disabled={pendingDecision !== null}
            loading={pendingDecision === false}
          >
            Deny
          </Button>
        </div>
      </CardPanel>
    </Card>
  );
}

function getRedirectUri(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "redirect_uri" in value &&
    typeof value.redirect_uri === "string"
  ) {
    return value.redirect_uri;
  }

  return null;
}
