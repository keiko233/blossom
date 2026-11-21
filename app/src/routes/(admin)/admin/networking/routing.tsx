import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { z } from "zod";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import type {
  ApplyNetworkingRolloutInput,
  PlanNetworkingRolloutInput,
} from "@/lib/networking-schema";
import {
  buildRoutingPreview,
  diffRoutingDrafts,
  type RoutingDiff,
} from "@/lib/networking-workspace";
import { m } from "@/paraglide/messages";
import {
  applyNetworkingRollout,
  planNetworkingRollout,
  saveRouting,
  type NetworkingRolloutApplyResult,
  type NetworkingRolloutPlanResult,
  type RoutingDraftSaveResult,
} from "@/query/networking";

import { NetworkingSection } from "./_modules/networking-badges";
import { NetworkingIssues } from "./_modules/networking-issues";
import { NetworkingRollouts } from "./_modules/networking-rollouts";
import {
  networkingApplyReasonMessage,
  networkingWriteReasonMessage,
} from "./_modules/networking-write-message";
import { RoutingPlanPanel } from "./_modules/routing-plan";
import { RoutingPreviewPanel } from "./_modules/routing-preview";
import { RoutingRuleDialog } from "./_modules/routing-rule-dialog";
import {
  useInvalidateNetworking,
  useNetworkingWorkspace,
  useServerRouting,
} from "./_modules/use-networking-workspace";

export const Route = createFileRoute("/(admin)/admin/networking/routing")({
  staticData: {
    crumb: () => m.admin_workspace_networking_routing(),
  },
  validateSearch: z.object({
    server: z.string().optional(),
  }),
  component: RouteComponent,
});

interface DraftState {
  serverId: string;
  finalOutboundTag: string;
  rules: ManagedIntentRouteRule[];
}

function RouteComponent(): React.ReactElement {
  const search = Route.useSearch();
  const { data: workspace, isPending: workspacePending } =
    useNetworkingWorkspace();
  const servers = workspace?.servers ?? [];
  const [serverId, setServerId] = useState<string | null>(
    search.server ?? null,
  );
  const effectiveServerId = serverId ?? servers[0]?.id ?? null;
  const {
    data: view,
    isPending,
    isError,
    refetch,
  } = useServerRouting(effectiveServerId);
  const invalidate = useInvalidateNetworking();

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loadedServerId, setLoadedServerId] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<RoutingDiff | null>(null);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<RoutingDraftSaveResult | null>(
    null,
  );
  const [planError, setPlanError] = useState<string | null>(null);
  const [applyResult, setApplyResult] =
    useState<NetworkingRolloutApplyResult | null>(null);

  useEffect(() => {
    if (!search.server) return;
    setServerId(search.server);
    setLoadedServerId(null);
  }, [search.server]);

  useEffect(() => {
    if (!view || loadedServerId === view.server.id) return;
    const rules = view.routing?.rules ?? [];
    const finalOutboundTag = view.routing?.finalOutboundTag ?? "direct";
    setDraft({ serverId: view.server.id, finalOutboundTag, rules });
    setLoadedServerId(view.server.id);
    setSavedSnapshot(null);
    setSaveResult(null);
    setPlanError(null);
    planMutation.reset();
  }, [view, loadedServerId]);

  const planInputFor = (state: DraftState): PlanNetworkingRolloutInput => {
    const usedPeerDestinations = new Set<string>();
    if (view) {
      for (const tag of state.rules
        .filter((rule) => rule.action === "route")
        .map((rule) => rule.outboundTag)) {
        if (!tag || !tag.startsWith("peer-out-")) continue;
        const outbound = view.outboundOptions.find((row) => row.tag === tag);
        if (outbound?.destinationServerId)
          usedPeerDestinations.add(outbound.destinationServerId);
      }
    }
    return {
      serverIds: [...new Set([state.serverId, ...usedPeerDestinations])],
      draft: {
        serverId: state.serverId,
        finalOutboundTag: state.finalOutboundTag,
        rules: state.rules,
        expectedTopologyGeneration: view?.topologyGeneration ?? 0,
      },
    };
  };

  const planMutation = useMutation({
    mutationFn: (input: PlanNetworkingRolloutInput) =>
      planNetworkingRollout({ data: input }),
  });

  const applyMutation = useMutation({
    mutationFn: (input: ApplyNetworkingRolloutInput) =>
      applyNetworkingRollout({ data: input }),
  });

  if (workspacePending || isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (isError || !view || !effectiveServerId) {
    return (
      <div className="flex flex-col gap-3 p-4 md:p-6">
        <p className="text-sm text-destructive">
          {m.admin_networking_load_error()}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {m.admin_networking_action_retry()}
        </Button>
      </div>
    );
  }

  if (!draft || draft.serverId !== effectiveServerId) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }

  const preview = buildRoutingPreview({
    rules: draft.rules,
    finalOutboundTag: draft.finalOutboundTag,
    inbounds: view.inbounds,
    outbounds: view.outboundOptions,
    ruleSets: view.ruleSetOptions,
  });
  const previousRules = view.routing?.rules ?? [];
  const previousFinal = view.routing?.finalOutboundTag ?? "direct";
  const diff = diffRoutingDrafts(
    { rules: previousRules, finalOutboundTag: previousFinal },
    { rules: draft.rules, finalOutboundTag: draft.finalOutboundTag },
  );
  const dirty =
    JSON.stringify(draft.rules) !== JSON.stringify(previousRules) ||
    draft.finalOutboundTag !== previousFinal;
  const editingRule =
    editingRuleId === null
      ? null
      : (draft.rules.find((rule) => rule.ruleId === editingRuleId) ?? null);
  const plan = planMutation.data as NetworkingRolloutPlanResult | undefined;
  const planFresh = Boolean(
    plan &&
    planMutation.variables &&
    JSON.stringify(planMutation.variables) ===
      JSON.stringify(planInputFor(draft)),
  );

  const setRule = (next: ManagedIntentRouteRule) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            rules: current.rules.map((rule) =>
              rule.ruleId === next.ruleId ? next : rule,
            ),
          }
        : current,
    );
  };

  const addRule = (next: ManagedIntentRouteRule) => {
    setDraft((current) =>
      current ? { ...current, rules: [...current.rules, next] } : current,
    );
  };

  const removeRule = (ruleId: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            rules: current.rules.filter((rule) => rule.ruleId !== ruleId),
          }
        : current,
    );
  };

  const moveRule = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current;
      const target = index + offset;
      if (target < 0 || target >= current.rules.length) return current;
      const rules = [...current.rules];
      const [item] = rules.splice(index, 1);
      rules.splice(target, 0, item!);
      return { ...current, rules };
    });
  };

  const save = async () => {
    setSaveResult(null);
    const result = await saveRouting({
      data: {
        serverId: draft.serverId,
        finalOutboundTag: draft.finalOutboundTag,
        rules: draft.rules,
        expectedTopologyGeneration: view.topologyGeneration,
      },
    });
    setSaveResult(result);
    if (!result.ok) {
      setPlanError(null);
      return;
    }
    setSavedSnapshot(diff);
    toastManager.add({
      type: "success",
      title: m.admin_networking_routing_toast_saved(),
    });
    await invalidate();
  };

  const runPlan = async () => {
    setPlanError(null);
    setApplyResult(null);
    try {
      await planMutation.mutateAsync(planInputFor(draft));
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : String(error));
    }
  };

  const apply = async () => {
    const planned = planMutation.data;
    const plannedInput = planMutation.variables;
    if (!planned || !plannedInput) return;
    const currentInput = planInputFor(draft);
    if (JSON.stringify(currentInput) !== JSON.stringify(plannedInput)) {
      setPlanError(m.admin_networking_apply_requires_plan());
      return;
    }
    setPlanError(null);
    try {
      const result = await applyMutation.mutateAsync({
        ...currentInput,
        expectedTopologyGeneration: planned.topologyGeneration,
      });
      setApplyResult(result);
      if (result.ok) {
        toastManager.add({
          type: "success",
          title: m.admin_networking_apply_admitted({
            count: result.plan?.stages.length ?? 0,
          }),
        });
        await invalidate();
      }
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <PageHeaderTitle>
            {m.admin_workspace_networking_routing()}
          </PageHeaderTitle>
          <p className="text-sm text-muted-foreground">
            {m.admin_networking_routing_description()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runPlan()}
            disabled={planMutation.isPending}
          >
            {m.admin_networking_action_plan_rollout()}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={!dirty}
          >
            {m.admin_networking_action_save_draft()}
          </Button>
          <Button
            size="sm"
            loading={applyMutation.isPending}
            disabled={
              !view.activationEnabled || !planFresh || !plan?.admissionReady
            }
            title={
              !view.activationEnabled
                ? m.admin_networking_activation_disabled_title()
                : !planFresh
                  ? m.admin_networking_apply_requires_plan()
                  : !plan?.admissionReady
                    ? m.admin_networking_apply_not_ready()
                    : undefined
            }
            onClick={() => void apply()}
          >
            {m.admin_networking_action_apply()}
          </Button>
        </div>
      </PageHeader>

      {view.activationEnabled ? null : (
        <Alert variant="info">
          <AlertTitle>
            {m.admin_networking_activation_disabled_title()}
          </AlertTitle>
          <AlertDescription>
            {m.admin_networking_activation_disabled_description()}
          </AlertDescription>
        </Alert>
      )}

      {saveResult && !saveResult.ok ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {saveResult.reason === "validation"
              ? m.admin_networking_validation_blocked()
              : networkingWriteReasonMessage(saveResult.reason ?? "unknown")}
          </p>
          <NetworkingIssues issues={saveResult.issues} />
        </div>
      ) : null}
      {planError ? (
        <p role="alert" className="text-sm text-destructive">
          {planError}
        </p>
      ) : null}
      {applyResult && !applyResult.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {networkingApplyReasonMessage(
            applyResult.reason ?? "invalid_admission",
          )}
        </p>
      ) : null}
      {applyResult?.ok ? (
        <p className="text-sm text-success-foreground">
          {m.admin_networking_apply_admitted({
            count: applyResult.plan?.stages.length ?? 0,
          })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Field className="w-full max-w-sm">
          <FieldLabel>{m.admin_networking_routing_server_label()}</FieldLabel>
          <Select
            value={effectiveServerId}
            onValueChange={(value) => {
              setServerId(value ?? null);
              setLoadedServerId(null);
            }}
          >
            <SelectTrigger>
              <SelectValue>
                {(value: string) =>
                  servers.find((row) => row.id === value)?.name ?? value
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {servers.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Badge variant={dirty ? "warning" : "outline"}>
          {dirty
            ? m.admin_networking_unsaved()
            : m.admin_networking_routing_saved_badge({
                version: view.routing?.version ?? 0,
              })}
        </Badge>
        {view.managedState?.desiredConfigVersionId ? (
          <Badge variant="outline">
            {m.admin_networking_routing_pointer({
              version: view.managedState.desiredConfigVersionId.slice(0, 12),
            })}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <NetworkingSection
            title={m.admin_networking_routing_rules_title()}
            description={m.admin_networking_routing_rules_description()}
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setEditingRuleId(null);
                  setRuleDialogOpen(true);
                }}
              >
                <PlusIcon />
                {m.admin_networking_routing_add_rule()}
              </Button>
            }
          >
            <Field>
              <FieldLabel>
                {m.admin_networking_routing_final_label()}
              </FieldLabel>
              <Select
                value={draft.finalOutboundTag}
                onValueChange={(value) =>
                  value &&
                  setDraft((current) =>
                    current ? { ...current, finalOutboundTag: value } : current,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {(value: string) =>
                      view.outboundOptions.find((row) => row.tag === value)
                        ?.name ?? value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {view.outboundOptions
                    .filter((row) => row.kind !== "peer_link")
                    .map((row) => (
                      <SelectItem key={row.tag} value={row.tag}>
                        {row.name}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
              <FieldDescription>
                {m.admin_networking_routing_final_hint()}
              </FieldDescription>
            </Field>

            {preview.issues.filter(
              (issue) =>
                issue.code === "unknown_final_outbound" ||
                issue.code === "final_outbound_is_peer",
            ).length > 0 ? (
              <p className="text-sm text-destructive">
                <CircleAlertIcon className="me-1 inline size-4" />
                {m.admin_networking_routing_final_invalid()}
              </p>
            ) : null}

            {draft.rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {m.admin_networking_routing_no_rules()}
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {draft.rules.map((rule, index) => (
                  <li
                    key={rule.ruleId}
                    data-slot="routing-rule"
                    className="flex flex-col gap-2 rounded-lg border bg-background p-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {rule.ruleId}
                      </span>
                      <Badge
                        variant={rule.action === "reject" ? "error" : "success"}
                      >
                        {rule.action === "reject"
                          ? m.admin_networking_routing_rule_reject()
                          : m.admin_networking_routing_rule_route()}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_routing_move_up()}
                        disabled={index === 0}
                        onClick={() => moveRule(index, -1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_routing_move_down()}
                        disabled={index === draft.rules.length - 1}
                        onClick={() => moveRule(index, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_action_edit()}
                        onClick={() => {
                          setEditingRuleId(rule.ruleId);
                          setRuleDialogOpen(true);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={m.admin_networking_action_delete()}
                        onClick={() => removeRule(rule.ruleId)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                      <span className="font-mono">
                        {rule.inboundTags.join(", ")}
                      </span>
                      {rule.network ? (
                        <Badge variant="outline">{rule.network}</Badge>
                      ) : null}
                      {rule.sniff ? (
                        <Badge variant="outline">
                          {m.admin_networking_routing_rule_sniff_short()}
                        </Badge>
                      ) : null}
                      {rule.outboundTag ? (
                        <span className="font-mono">→ {rule.outboundTag}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </NetworkingSection>

          {savedSnapshot ? (
            <p className="text-xs text-muted-foreground">
              {m.admin_networking_routing_last_saved()}
            </p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <RoutingPreviewPanel preview={preview} diff={diff} />
          <RoutingPlanPanel
            plan={plan ?? null}
            pending={planMutation.isPending}
          />
          <NetworkingRollouts
            rollouts={view.rollouts}
            activationEnabled={view.activationEnabled}
          />
        </div>
      </div>

      <RoutingRuleDialog
        open={ruleDialogOpen}
        onOpenChange={(open) => {
          setRuleDialogOpen(open);
          if (!open) setEditingRuleId(null);
        }}
        rule={editingRule}
        inbounds={view.inbounds}
        outbounds={view.outboundOptions}
        ruleSets={view.ruleSetOptions}
        onSave={(rule) => (editingRule ? setRule(rule) : addRule(rule))}
      />
    </div>
  );
}
