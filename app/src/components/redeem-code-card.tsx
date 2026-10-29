import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TicketIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import {
  type RedeemFailureReason,
  type RedeemResult,
} from "@/lib/redeem-batch";
import { REDEEM_INPUT_MAX_LENGTH } from "@/orpc/redeem/schema";
import { m } from "@/paraglide/messages";
import { myAnnouncementsQueryKey } from "@/query/announcements";
import { currentUserQueryKey } from "@/query/current-user";
import { redeemCode } from "@/query/redeem-user";

function failureMessage(reason: RedeemFailureReason): string {
  switch (reason) {
    case "throttled":
      return m.user_redeem_error_throttled();
    case "already_redeemed":
      return m.user_redeem_error_already_redeemed();
    case "user_limit":
      return m.user_redeem_error_user_limit();
    case "invalid":
      return m.user_redeem_error_invalid();
  }
}

export interface RedeemCodeCardProps {
  userId: string;
}

/**
 * "Redeem a code" form. On success it refreshes the user's subscription data
 * (and the announcement feed, whose audience depends on active plans).
 */
export function RedeemCodeCard({ userId }: RedeemCodeCardProps) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [result, setResult] = useState<RedeemResult | null>(null);

  const mutation = useMutation({
    mutationFn: (input: string) => redeemCode({ data: { code: input } }),
    onSuccess: async (outcome) => {
      setResult(outcome);
      if (!outcome.ok) return;
      setCode("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: currentUserQueryKey(userId),
        }),
        queryClient.invalidateQueries({
          queryKey: myAnnouncementsQueryKey(userId),
        }),
      ]);
    },
    onError: () => {
      // Unexpected failure (network, server): not a verdict on the code.
      setResult(null);
    },
  });

  const submit = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setResult(null);
    mutation.mutate(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TicketIcon className="size-4 text-muted-foreground" />
          {m.user_redeem_title()}
        </CardTitle>
        <CardDescription>{m.user_redeem_description()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label={m.user_redeem_input_label()}
            autoCapitalize="characters"
            autoComplete="off"
            className="font-mono uppercase"
            maxLength={REDEEM_INPUT_MAX_LENGTH}
            placeholder={m.user_redeem_input_placeholder()}
            spellCheck={false}
            value={code}
            onValueChange={(value) => {
              setCode(value);
              if (result && !result.ok) setResult(null);
            }}
          />
          <Button
            className="sm:w-auto"
            disabled={!code.trim()}
            loading={mutation.isPending}
            type="submit"
          >
            {m.user_redeem_submit()}
          </Button>
        </form>

        {mutation.isError ? (
          <Alert variant="error">
            <AlertDescription>{m.user_redeem_error_generic()}</AlertDescription>
          </Alert>
        ) : null}

        {result && !result.ok ? (
          <Alert variant="error">
            <AlertDescription>{failureMessage(result.reason)}</AlertDescription>
          </Alert>
        ) : null}

        {result?.ok ? (
          <Alert variant="success">
            <AlertTitle>
              {result.action === "extended"
                ? m.user_redeem_success_extended_title()
                : m.user_redeem_success_title()}
            </AlertTitle>
            <AlertDescription>
              {m.user_redeem_success_description({
                plan: result.planName,
                date: formatDate(result.expiresAt),
              })}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
