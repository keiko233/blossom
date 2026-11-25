import { useMutation } from "@tanstack/react-query";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  abortManagedRollout,
  retryManagedRollout,
} from "@/query/managed-rollout";
import type { NetworkingRolloutView } from "@/query/networking-read";

import { RolloutStatusBadge, StageStatusBadge } from "./networking-badges";
import { networkingRolloutReasonMessage } from "./networking-write-message";
import { useInvalidateNetworking } from "./use-networking-workspace";

type RolloutAction = "retry" | "abort";

/**
 * Rollout journal as a flat list. Used in the topology rail and on the Links
 * and Routing pages; it is never wrapped in a card, so it composes anywhere.
 */
export function NetworkingRollouts({
  rollouts,
  activationEnabled,
}: {
  rollouts: readonly NetworkingRolloutView[];
  activationEnabled: boolean;
}): React.ReactElement {
  const invalidate = useInvalidateNetworking();
  const actionMutation = useMutation({
    mutationFn: async (input: { rolloutId: string; action: RolloutAction }) => {
      const response =
        input.action === "retry"
          ? await retryManagedRollout({ data: { rolloutId: input.rolloutId } })
          : await abortManagedRollout({ data: { rolloutId: input.rolloutId } });
      return { ...input, response };
    },
    onSuccess: async ({ action, response }) => {
      if (response.result.ok) {
        toastManager.add({
          type: "success",
          title:
            action === "retry"
              ? response.result.action === "probe_issued"
                ? m.admin_networking_rollout_retry_probe_issued()
                : m.admin_networking_rollout_retry_extended()
              : response.result.action === "finished"
                ? m.admin_networking_rollout_abort_finished()
                : m.admin_networking_rollout_abort_compensated(),
        });
      } else {
        toastManager.add({
          type: "error",
          title: m.admin_networking_rollout_toast_action_failed(),
          description: networkingRolloutReasonMessage(response.result.reason),
        });
      }
      await invalidate();
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: m.admin_networking_rollout_toast_action_failed(),
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const requestAbort = async (rolloutId: string) => {
    await Confirm.call({
      title: m.admin_networking_rollout_abort_title(),
      description: m.admin_networking_rollout_abort_description(),
      confirmLabel: m.admin_networking_action_abort(),
      cancelLabel: m.admin_networking_action_cancel(),
      destructive: true,
      onConfirm: () =>
        actionMutation.mutateAsync({ rolloutId, action: "abort" }),
    });
  };

  return (
    <section data-slot="networking-rollouts" className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {m.admin_networking_rollout_description()}
      </p>
      {rollouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_networking_rollout_empty()}
        </p>
      ) : (
        <ul className="flex flex-col divide-y border-y">
          {rollouts.map((rollout) => (
            <li
              key={rollout.rolloutId}
              data-slot="networking-rollout"
              className="flex flex-col gap-2 py-3 first:pt-2 last:pb-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <BadgeId id={rollout.rolloutId} />
                <RolloutStatusBadge status={rollout.status} />
                {rollout.paused ? (
                  <span className="text-xs text-warning-foreground">
                    {m.admin_networking_rollout_paused()}
                  </span>
                ) : null}
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {m.admin_networking_rollout_updated({
                    time: formatDateTime(rollout.updatedAt),
                  })}
                </span>
              </div>

              <ul className="flex flex-col gap-1">
                {rollout.stages.map((stage) => (
                  <li
                    key={`${rollout.rolloutId}-${stage.ordinal}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {stage.ordinal}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {stage.serverName}
                    </span>
                    <StageStatusBadge status={stage.status} />
                    {stage.deadlineAt ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {m.admin_networking_rollout_stage_deadline({
                          time: formatDateTime(stage.deadlineAt),
                        })}
                      </span>
                    ) : null}
                    {stage.probeLinkId ? (
                      <span className="text-xs text-muted-foreground">
                        {m.admin_networking_rollout_stage_probe()}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {rollout.claimsHeld
                    ? m.admin_networking_rollout_claims_held({
                        count: rollout.claimedServerIds.length,
                      })
                    : m.admin_networking_rollout_claims_released()}
                </span>
                {rollout.failureCode ? (
                  <span className="text-destructive">
                    {m.admin_networking_rollout_failure({
                      code: rollout.failureCode,
                    })}
                  </span>
                ) : null}
              </div>

              {rollout.actions.retry || rollout.actions.abort ? (
                <div className="flex flex-wrap gap-2">
                  {rollout.actions.retry ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!activationEnabled}
                      loading={
                        actionMutation.isPending &&
                        actionMutation.variables?.rolloutId ===
                          rollout.rolloutId &&
                        actionMutation.variables.action === "retry"
                      }
                      title={
                        activationEnabled
                          ? undefined
                          : m.admin_networking_activation_disabled_title()
                      }
                      onClick={() =>
                        actionMutation.mutate({
                          rolloutId: rollout.rolloutId,
                          action: "retry",
                        })
                      }
                    >
                      {m.admin_networking_action_retry()}
                    </Button>
                  ) : null}
                  {rollout.actions.abort ? (
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={!activationEnabled}
                      loading={
                        actionMutation.isPending &&
                        actionMutation.variables?.rolloutId ===
                          rollout.rolloutId &&
                        actionMutation.variables.action === "abort"
                      }
                      title={
                        activationEnabled
                          ? undefined
                          : m.admin_networking_activation_disabled_title()
                      }
                      onClick={() => void requestAbort(rollout.rolloutId)}
                    >
                      {m.admin_networking_action_abort()}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BadgeId({ id }: { id: string }): React.ReactElement {
  return (
    <span
      className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
      title={id}
    >
      {id.slice(0, 12)}
    </span>
  );
}
