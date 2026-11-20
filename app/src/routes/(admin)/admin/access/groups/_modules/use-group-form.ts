import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import { isGroupRevisionConflict } from "@/lib/group-revision-conflict";
import { m } from "@/paraglide/messages";
import {
  createGroup,
  getGroup,
  GROUPS_QUERY_KEY,
  updateGroup,
} from "@/query/groups";

/** Group row (with `revision`) plus its ordered member node ids. */
export type GroupWithNodes = Awaited<ReturnType<typeof getGroup>>;

export interface GroupFormValues {
  name: string;
  remark: string;
  sortOrder: number;
  /** Ordered membership draft; saved in this order. */
  nodeIds: string[];
}

function defaultValues(group?: GroupWithNodes): GroupFormValues {
  return {
    name: group?.name ?? "",
    remark: group?.remark ?? "",
    sortOrder: group?.sortOrder ?? 0,
    nodeIds: group?.nodeIds ?? [],
  };
}

function toPayload(v: GroupFormValues) {
  return {
    name: v.name,
    remark: v.remark || undefined,
    sortOrder: v.sortOrder,
    nodeIds: v.nodeIds,
  };
}

// Extracted so `ReturnType` yields a concrete form type for sub-components.
function useGroupForm(
  group: GroupWithNodes | undefined,
  onSubmit: (values: GroupFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues: defaultValues(group),
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });
}

export type GroupForm = ReturnType<typeof useGroupForm>;

export interface UseGroupFormControllerOptions {
  group?: GroupWithNodes;
  onSuccess: () => void;
}

/**
 * Owns the create/update mutation and the form instance for the full-page group
 * editor. The route component remounts per group (keyed by id), so no reset
 * effect is needed.
 */
export function useGroupFormController({
  group,
  onSuccess,
}: UseGroupFormControllerOptions): { form: GroupForm; isEdit: boolean } {
  const queryClient = useQueryClient();
  const isEdit = Boolean(group);

  const mutation = useMutation({
    mutationFn: async (values: GroupFormValues) => {
      const payload = toPayload(values);
      if (group) {
        // Supplying the loaded revision selects the ordered write: the server
        // stores this exact order or rejects a stale draft with
        // GROUP_REVISION_CONFLICT.
        await updateGroup({
          data: { id: group.id, expectedRevision: group.revision, ...payload },
        });
      } else {
        await createGroup({ data: payload });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_proxies_groups_toast_updated()
          : m.admin_proxies_groups_toast_created(),
      });
      onSuccess();
    },
    onError: (error) => {
      // The draft stays in the form so nothing is lost on a conflict.
      toastManager.add({
        type: "error",
        title: isGroupRevisionConflict(error)
          ? m.admin_proxies_groups_toast_conflict()
          : m.admin_proxies_groups_toast_error(),
      });
    },
  });

  const form = useGroupForm(group, async (values) => {
    await mutation.mutateAsync(values);
  });

  return { form, isEdit };
}
