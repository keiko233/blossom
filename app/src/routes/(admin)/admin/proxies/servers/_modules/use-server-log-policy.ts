import type {
  LogPolicyLevel,
  LogPolicySource,
} from "@blossom/contracts/log-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toastManager } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import type { ServerLogPolicyView } from "@/query/log-policy";
import {
  getServerLogPolicy,
  resetServerLogPolicy,
  updateServerLogPolicy,
} from "@/query/server-log-policy";

type LogPolicyResetMode = "restore-baseline" | "restore-default";

export type LogPolicyIntent =
  | {
      kind: "update";
      source: LogPolicySource;
      level: LogPolicyLevel;
      temporarySeconds?: number;
    }
  | {
      kind: "reset";
      source: LogPolicySource;
      mode: LogPolicyResetMode;
    };

interface LogPolicyConflict {
  intent: LogPolicyIntent;
  policy: ServerLogPolicyView | null;
}

function policyQueryKey(serverId: string) {
  return ["admin", "servers", serverId, "log-policy"] as const;
}

/**
 * Reads and mutates one server's log policy. Mutations resolve the compare-and-
 * swap revision from the cached read at call time, so an explicit retry after a
 * conflict uses the state the conflict response just reloaded. This query never
 * invalidates the log tail or search, and refresh is read-only.
 */
export function useServerLogPolicy(serverId: string) {
  const queryClient = useQueryClient();
  const queryKey = policyQueryKey(serverId);
  const [conflict, setConflict] = useState<LogPolicyConflict | null>(null);

  const policyQuery = useQuery({
    queryKey,
    queryFn: () => getServerLogPolicy({ data: { serverId } }),
    refetchInterval: (query) => {
      const policy = query.state.data;
      if (!policy) {
        return false;
      }
      const sources = Object.values(policy.sources);
      const waiting = sources.some(
        (source) =>
          source.pending ||
          source.effectivePending ||
          source.effectiveError !== null,
      );
      if (waiting) {
        return 10_000;
      }
      const now = Date.now();
      const deadlineSoon = sources.some((source) => {
        if (!source.desiredDeadline) {
          return false;
        }
        const deadline = new Date(source.desiredDeadline).getTime();
        return deadline > now && deadline - now <= 60_000;
      });
      return deadlineSoon ? 10_000 : false;
    },
    refetchIntervalInBackground: false,
  });

  const mutation = useMutation({
    mutationFn: (intent: LogPolicyIntent) => {
      const current = queryClient.getQueryData<ServerLogPolicyView>(queryKey);
      const expectedRevision = current?.revision ?? 0;
      if (intent.kind === "update") {
        return updateServerLogPolicy({
          data: {
            serverId,
            source: intent.source,
            level: intent.level,
            ...(intent.temporarySeconds === undefined
              ? {}
              : { temporarySeconds: intent.temporarySeconds }),
            expectedRevision,
          },
        });
      }
      return resetServerLogPolicy({
        data: {
          serverId,
          source: intent.source,
          mode: intent.mode,
          expectedRevision,
        },
      });
    },
    onSuccess: (result, intent) => {
      if (result.policy) {
        queryClient.setQueryData(queryKey, result.policy);
      } else {
        void queryClient.invalidateQueries({ queryKey });
      }
      if (result.ok) {
        setConflict(null);
        toastManager.add({
          type: "success",
          title: m.agent_logs_policy_toast_saved(),
        });
        return;
      }
      setConflict({ intent, policy: result.policy });
      toastManager.add({
        type: "warning",
        title: m.agent_logs_policy_toast_conflict(),
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.agent_logs_policy_toast_error(),
      });
    },
  });

  const apply = (intent: LogPolicyIntent) => mutation.mutate(intent);

  return {
    policy: policyQuery.data,
    loading: policyQuery.isLoading,
    error: policyQuery.error,
    refreshing: policyQuery.isFetching && !policyQuery.isLoading,
    refresh: () => policyQuery.refetch(),
    busy: mutation.isPending,
    activeIntent: mutation.isPending ? mutation.variables : undefined,
    conflict,
    dismissConflict: () => setConflict(null),
    retryConflict: () => {
      if (conflict) {
        mutation.mutate(conflict.intent);
      }
    },
    update: (
      source: LogPolicySource,
      level: LogPolicyLevel,
      temporarySeconds?: number,
    ) =>
      apply({
        kind: "update",
        source,
        level,
        ...(temporarySeconds === undefined ? {} : { temporarySeconds }),
      }),
    restore: (source: LogPolicySource, mode: LogPolicyResetMode) =>
      apply({ kind: "reset", source, mode }),
  };
}
