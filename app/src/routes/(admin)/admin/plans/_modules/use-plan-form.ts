import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import {
  amountToCents,
  bytesToGb,
  centsToAmount,
  gbToBytes,
} from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  createPlan,
  getPlan,
  PLANS_QUERY_KEY,
  updatePlan,
} from "@/query/plans";

/** Plan row plus its bound group ids, as returned by `getPlan`. */
export type PlanWithGroups = Awaited<ReturnType<typeof getPlan>>;

/**
 * Form state uses human units (currency major units, GB); the DB stores cents
 * and bytes. Conversion happens only here, in defaultValues/toPayload.
 */
export interface PlanFormValues {
  name: string;
  description: string;
  price: number;
  durationDays: number;
  trafficGb: number;
  deviceLimit: number;
  visible: boolean;
  sortOrder: number;
  groupIds: string[];
}

function defaultValues(plan?: PlanWithGroups): PlanFormValues {
  return {
    name: plan?.name ?? "",
    description: plan?.description ?? "",
    price: plan ? centsToAmount(plan.priceCents) : 0,
    durationDays: plan?.durationDays ?? 30,
    trafficGb: plan ? bytesToGb(plan.trafficBytes) : 100,
    deviceLimit: plan?.deviceLimit ?? 0,
    visible: plan?.visible ?? true,
    sortOrder: plan?.sortOrder ?? 0,
    groupIds: plan?.groupIds ?? [],
  };
}

function toPayload(v: PlanFormValues) {
  return {
    name: v.name,
    description: v.description || undefined,
    priceCents: amountToCents(v.price),
    durationDays: v.durationDays,
    trafficBytes: gbToBytes(v.trafficGb),
    deviceLimit: v.deviceLimit,
    visible: v.visible,
    sortOrder: v.sortOrder,
    groupIds: v.groupIds,
  };
}

// Extracted so `ReturnType` yields a concrete form type for sub-components.
function usePlanForm(
  plan: PlanWithGroups | undefined,
  onSubmit: (values: PlanFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues: defaultValues(plan),
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });
}

export type PlanForm = ReturnType<typeof usePlanForm>;

export interface UsePlanFormControllerOptions {
  plan?: PlanWithGroups;
  onSuccess: () => void;
}

/**
 * Owns the create/update mutation and the form instance for the full-page plan
 * editor. The route component remounts per plan (keyed by id), so no reset
 * effect is needed.
 */
export function usePlanFormController({
  plan,
  onSuccess,
}: UsePlanFormControllerOptions): { form: PlanForm; isEdit: boolean } {
  const queryClient = useQueryClient();
  const isEdit = Boolean(plan);

  const mutation = useMutation({
    mutationFn: async (values: PlanFormValues) => {
      const payload = toPayload(values);
      if (plan) {
        await updatePlan({ data: { id: plan.id, ...payload } });
      } else {
        await createPlan({ data: payload });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLANS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_plans_toast_updated()
          : m.admin_plans_toast_created(),
      });
      onSuccess();
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_plans_toast_error(),
      });
    },
  });

  const form = usePlanForm(plan, async (values) => {
    await mutation.mutateAsync(values);
  });

  return { form, isEdit };
}
