import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

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

/** Saved membership and revision the next write is based on. */
export interface GroupEditorBaseline {
  revision: number;
  nodeIds: string[];
}

export interface GroupRevisionConflictState {
  /** Revision the rejected write expected. */
  expectedRevision: number;
  /** Revision stored when the write was rejected. */
  currentRevision: number;
  /** Latest saved group, loaded after the conflict. */
  latest: GroupWithNodes | null;
  isPending: boolean;
  loadFailed: boolean;
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

function initialBaseline(group?: GroupWithNodes): GroupEditorBaseline {
  return {
    revision: group?.revision ?? 0,
    nodeIds: group?.nodeIds ?? [],
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

export interface UseGroupFormControllerResult {
  form: GroupForm;
  isEdit: boolean;
  /** Saved revision and order, updated when a conflict is reloaded. */
  baseline: GroupEditorBaseline;
  conflict: GroupRevisionConflictState | null;
  /** Reload the latest saved revision/order and keep the current draft. */
  reloadLatestKeepingDraft: () => void;
  /** Replace the membership draft with the latest saved order. */
  useLatestSavedOrder: () => void;
  /** Retry the latest-group read after a failed conflict load. */
  retryConflictLoad: () => void;
}

/**
 * Owns the create/update mutation, the form instance and the stale-revision
 * conflict state for the full-page group editor.
 *
 * The baseline carries the revision the next write must match. On a
 * `GROUP_REVISION_CONFLICT` the editor fetches the latest saved group and can
 * adopt its revision while leaving the user's draft untouched, or replace the
 * membership draft with the saved order. Form fields (name, remark, sort) are
 * never overwritten by the reload, so no typing is lost.
 */
export function useGroupFormController({
  group,
  onSuccess,
}: UseGroupFormControllerOptions): UseGroupFormControllerResult {
  const queryClient = useQueryClient();
  const isEdit = Boolean(group);

  const [baseline, setBaseline] = React.useState(() => initialBaseline(group));
  const baselineRef = React.useRef(baseline);
  const [conflict, setConflict] =
    React.useState<GroupRevisionConflictState | null>(null);

  const adoptBaseline = (next: GroupEditorBaseline) => {
    baselineRef.current = next;
    setBaseline(next);
  };

  const loadLatest = async (known: GroupRevisionConflictState) => {
    if (!group) return;
    setConflict({ ...known, latest: null, isPending: true, loadFailed: false });
    try {
      const latest = await getGroup({ data: { id: group.id } });
      setConflict((current) =>
        current
          ? { ...current, latest, isPending: false, loadFailed: false }
          : current,
      );
    } catch {
      setConflict((current) =>
        current
          ? { ...current, latest: null, isPending: false, loadFailed: true }
          : current,
      );
    }
  };

  const mutation = useMutation({
    mutationFn: async (values: GroupFormValues) => {
      const payload = toPayload(values);
      if (group) {
        // The baseline revision is the optimistic token. A stale one is
        // rejected with GROUP_REVISION_CONFLICT and leaves the draft intact.
        await updateGroup({
          data: {
            id: group.id,
            expectedRevision: baselineRef.current.revision,
            ...payload,
          },
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
      if (group && isGroupRevisionConflict(error)) {
        void loadLatest({
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
          latest: null,
          isPending: true,
          loadFailed: false,
        });
        toastManager.add({
          type: "error",
          title: m.admin_proxies_groups_toast_conflict(),
        });
        return;
      }
      toastManager.add({
        type: "error",
        title: m.admin_proxies_groups_toast_error(),
      });
    },
  });

  const form = useGroupForm(group, async (values) => {
    await mutation.mutateAsync(values);
  });

  const reloadLatestKeepingDraft = () => {
    if (!conflict?.latest) return;
    adoptBaseline({
      revision: conflict.latest.revision,
      nodeIds: [...conflict.latest.nodeIds],
    });
    setConflict(null);
  };

  const useLatestSavedOrder = () => {
    if (!conflict?.latest) return;
    adoptBaseline({
      revision: conflict.latest.revision,
      nodeIds: [...conflict.latest.nodeIds],
    });
    form.setFieldValue("nodeIds", [...conflict.latest.nodeIds]);
    setConflict(null);
  };

  const retryConflictLoad = () => {
    if (conflict) void loadLatest(conflict);
  };

  return {
    form,
    isEdit,
    baseline,
    conflict,
    reloadLatestKeepingDraft,
    useLatestSavedOrder,
    retryConflictLoad,
  };
}
