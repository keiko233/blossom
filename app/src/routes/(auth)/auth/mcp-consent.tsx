import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import Ring from "@/components/ui/ring";
import { getSession } from "@/lib/auth";

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
  const [isSubmitting, setIsSubmitting] = useState(false);

  const oauthQuery =
    typeof window !== "undefined" ? window.location.search.slice(1) : "";

  const handleDecision = async (accept: boolean) => {
    setIsSubmitting(true);
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

      const data = await response.json();
      if (data.redirect_uri) {
        window.location.href = data.redirect_uri;
      }
    } catch {
      setIsSubmitting(false);
    }
  };

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
          </ul>
        </div>

        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => handleDecision(true)}
            disabled={isSubmitting}
          >
            {isSubmitting ? <Ring className="shrink-0" /> : "Approve"}
          </Button>
          <Button
            className="flex-1"
            variant="secondary"
            onClick={() => handleDecision(false)}
            disabled={isSubmitting}
          >
            Deny
          </Button>
        </div>
      </CardPanel>
    </Card>
  );
}
