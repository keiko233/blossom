import type React from "react";

import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { NetworkingRolloutView } from "@/query/networking-read";

import {
  NetworkingSection,
  RolloutStatusBadge,
  StageStatusBadge,
} from "./networking-badges";

export function NetworkingRollouts({
  rollouts,
}: {
  rollouts: readonly NetworkingRolloutView[];
}): React.ReactElement {
  return (
    <NetworkingSection
      title={m.admin_networking_rollout_title()}
      description={m.admin_networking_rollout_description()}
    >
      {rollouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_networking_rollout_empty()}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rollouts.map((rollout) => (
            <li
              key={rollout.rolloutId}
              data-slot="networking-rollout"
              className="flex flex-col gap-2 rounded-lg border bg-background p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <BadgeId id={rollout.rolloutId} />
                  <RolloutStatusBadge status={rollout.status} />
                  {rollout.paused ? (
                    <span className="text-xs text-warning-foreground">
                      {m.admin_networking_rollout_paused()}
                    </span>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">
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
                    <span className="font-mono text-xs text-muted-foreground">
                      {stage.ordinal}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {stage.serverName}
                    </span>
                    <StageStatusBadge status={stage.status} />
                    {stage.deadlineAt ? (
                      <span className="text-xs text-muted-foreground">
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
                <span>
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
            </li>
          ))}
        </ul>
      )}
    </NetworkingSection>
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
