import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  defaultsFromSchema,
  pruneSettings,
} from "@/components/schema-form/schema-defaults";
import { toastManager } from "@/components/ui/toast";
import type { JsonValue } from "@/orpc/proxy/schema";
import {
  isNodeRealityEnabled,
  isNodeTlsEnabled,
  NODE_PROTOCOLS,
  type NodeProtocol,
  protocolSupportsTls,
  settingsSchemaFor,
  withoutManagedCertificateTlsFields,
} from "@/orpc/proxy/sing-box-registry";
import { m } from "@/paraglide/messages";
import { createNode, NODES_QUERY_KEY, updateNode } from "@/query/nodes";
import type { NodeDetail } from "@/query/nodes";
import { SERVERS_QUERY_KEY } from "@/query/servers";

export interface NodeFormValues {
  name: string;
  remark: string;
  tags: string;
  enabled: boolean;
  serverId: string;
  tlsMode: "managed" | "manual";
  certificateId: string;
  tlsServerName: string;
  // Address override. Empty string means "no override": send `null` to the
  // backend so the node falls back to its server's address.
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

function defaultValues(node: NodeDetail | undefined): NodeFormValues {
  const protocol = node?.protocol ?? NODE_PROTOCOLS[0];
  // `NodeFormPage` only renders when there is at least one server (see create
  // page guard); when editing, the node's existing server is the default.
  return {
    name: node?.name ?? "",
    remark: node?.remark ?? "",
    tags: (node?.tags ?? []).join(", "),
    enabled: node?.enabled ?? true,
    serverId: node?.serverId ?? "",
    tlsMode: node?.certificateId ? "managed" : "manual",
    certificateId: node?.certificateId ?? "",
    tlsServerName: node?.tlsServerName ?? "",
    address: node?.address ?? "",
    listenPort: node?.listenPort ?? 443,
    protocol,
    settings: node?.settings ?? settingsDefaults(protocol),
  };
}

function toPayload(v: NodeFormValues) {
  const usesManagedCertificate =
    v.tlsMode === "managed" &&
    protocolSupportsTls(v.protocol) &&
    isNodeTlsEnabled(v.settings) &&
    !isNodeRealityEnabled(v.settings) &&
    Boolean(v.certificateId);
  const settings = usesManagedCertificate
    ? withoutManagedCertificateTlsFields(v.settings)
    : structuredClone(v.settings);
  const pruned = pruneSettings(settings, settingsSchemaFor(v.protocol)) as
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
    serverId: v.serverId,
    certificateId: usesManagedCertificate ? v.certificateId : null,
    tlsServerName: usesManagedCertificate ? v.tlsServerName || null : null,
    // Empty override → null (fall back to server.address). A non-empty string
    // is the per-node override. `updateNode` distinguishes undefined (leave
    // alone) from null (clear); we never want to leave it alone on save.
    address: v.address.trim() === "" ? null : v.address.trim(),
    listenPort: v.listenPort,
    protocol: v.protocol,
    settings: pruned ?? {},
  };
}

// Extracted so `ReturnType` yields a concrete form type for sub-components.
function useNodeForm(
  node: NodeDetail | undefined,
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
  node?: NodeDetail;
  /**
   * Called after a successful save. The create flow no longer mints an agent
   * token (the owning server carries it), so there is no token to reveal.
   */
  onSuccess: () => void;
}

/**
 * Owns the create/update mutation and the form instance for the full-page node
 * editor. The route component remounts per node (keyed by id), so no reset
 * effect is needed. `createNode` returns only the row — no token, since the
 * owning server owns the agent credential.
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
        return;
      }
      await createNode({ data: payload });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      // Server nodeCount changes on create/delete and (potentially) on
      // server-id edits; invalidate so the servers list reflects it.
      await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_proxies_nodes_toast_updated()
          : m.admin_proxies_nodes_toast_created(),
      });
      onSuccess();
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
