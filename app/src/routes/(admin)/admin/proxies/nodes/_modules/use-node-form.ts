import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  defaultsFromSchema,
  pruneSettings,
} from "@/components/schema-form/schema-defaults";
import { toastManager } from "@/components/ui/toast";
import type { Node } from "@/db/proxy-schema";
import { createNode, NODES_QUERY_KEY, updateNode } from "@/lib/nodes";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  NODE_PROTOCOLS,
  type NodeProtocol,
  settingsSchemaFor,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";

export interface NodeFormValues {
  name: string;
  remark: string;
  tags: string;
  enabled: boolean;
  address: string;
  listenPort: number;
  protocol: NodeProtocol;
  // Native sing-box inbound fragment (managed fields omitted); rendered by SchemaForm.
  settings: Record<string, unknown>;
}

export function settingsDefaults(
  protocol: NodeProtocol,
): Record<string, unknown> {
  return defaultsFromSchema(settingsSchemaFor(protocol)) as Record<
    string,
    unknown
  >;
}

function defaultValues(node?: Node): NodeFormValues {
  const protocol = node?.protocol ?? NODE_PROTOCOLS[0];
  return {
    name: node?.name ?? "",
    remark: node?.remark ?? "",
    tags: (node?.tags ?? []).join(", "),
    enabled: node?.enabled ?? true,
    address: node?.address ?? "",
    listenPort: node?.listenPort ?? 443,
    protocol,
    settings: node?.settings ?? settingsDefaults(protocol),
  };
}

function toPayload(v: NodeFormValues) {
  const pruned = pruneSettings(v.settings, settingsSchemaFor(v.protocol)) as
    | Record<string, JsonValue>
    | undefined;
  return {
    name: v.name,
    remark: v.remark || undefined,
    tags: v.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    enabled: v.enabled,
    address: v.address,
    listenPort: v.listenPort,
    protocol: v.protocol,
    settings: pruned ?? {},
  };
}

// Extracted so `ReturnType` yields a concrete form type for sub-components.
function useNodeForm(
  node: Node | undefined,
  onSubmit: (values: NodeFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues: defaultValues(node),
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });
}

export type NodeForm = ReturnType<typeof useNodeForm>;

export interface UseNodeFormControllerOptions {
  node?: Node;
  /**
   * Called after a successful save. `token` is the one-time plaintext agent token,
   * present only on create; the page reveals it before navigating back to the list.
   */
  onSuccess: (result: { token?: string }) => void;
}

/**
 * Owns the create/update mutation and the form instance for the full-page node
 * editor. The route component remounts per node (keyed by id), so no reset effect is
 * needed. The component consumes `{ form, isEdit }` and renders fields.
 */
export function useNodeFormController({
  node,
  onSuccess,
}: UseNodeFormControllerOptions): { form: NodeForm; isEdit: boolean } {
  const queryClient = useQueryClient();
  const isEdit = Boolean(node);

  const mutation = useMutation({
    mutationFn: async (values: NodeFormValues) => {
      const payload = toPayload(values);
      if (node) {
        await updateNode({ data: { id: node.id, ...payload } });
        return { token: undefined as string | undefined };
      }
      const result = await createNode({ data: payload });
      return { token: result.token };
    },
    onSuccess: async ({ token }) => {
      await queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_proxies_nodes_toast_updated()
          : m.admin_proxies_nodes_toast_created(),
      });
      onSuccess({ token });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_nodes_toast_error(),
      });
    },
  });

  const form = useNodeForm(node, async (values) => {
    await mutation.mutateAsync(values);
  });

  return { form, isEdit };
}
