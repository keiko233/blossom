import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import { createServer, SERVERS_QUERY_KEY, updateServer } from "@/query/servers";
import type { ServerDTO } from "@/query/servers";

export interface ServerFormValues {
  name: string;
  remark: string;
  enabled: boolean;
  address: string;
  configPollIntervalSeconds: number;
  heartbeatIntervalSeconds: number;
}

function defaultValues(server?: ServerDTO): ServerFormValues {
  return {
    name: server?.name ?? "",
    remark: server?.remark ?? "",
    enabled: server?.enabled ?? true,
    address: server?.address ?? "",
    configPollIntervalSeconds: server?.configPollIntervalSeconds ?? 60,
    heartbeatIntervalSeconds: server?.heartbeatIntervalSeconds ?? 30,
  };
}

function toPayload(v: ServerFormValues) {
  return {
    name: v.name,
    remark: v.remark || undefined,
    enabled: v.enabled,
    address: v.address,
    configPollIntervalSeconds: v.configPollIntervalSeconds,
    heartbeatIntervalSeconds: v.heartbeatIntervalSeconds,
  };
}

// Extracted so `ReturnType` yields a concrete form type for sub-components.
function useServerForm(
  server: ServerDTO | undefined,
  onSubmit: (values: ServerFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues: defaultValues(server),
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });
}

export type ServerForm = ReturnType<typeof useServerForm>;

export interface UseServerFormControllerOptions {
  server?: ServerDTO;
  /**
   * Called after a successful save. `token` is the one-time plaintext agent
   * token, present only on create; the page reveals it before navigating back.
   */
  onSuccess: (result: { token?: string }) => void | Promise<void>;
}

/**
 * Owns the create/update mutation and the form instance for the full-page
 * server editor. The route component remounts per server (keyed by id), so no
 * reset effect is needed.
 */
export function useServerFormController({
  server,
  onSuccess,
}: UseServerFormControllerOptions): { form: ServerForm; isEdit: boolean } {
  const queryClient = useQueryClient();
  const isEdit = Boolean(server);

  const mutation = useMutation({
    mutationFn: async (values: ServerFormValues) => {
      const payload = toPayload(values);
      if (server) {
        await updateServer({ data: { id: server.id, ...payload } });
        return { token: undefined as string | undefined };
      }
      const result = await createServer({ data: payload });
      return { token: result.token };
    },
    onSuccess: async ({ token }) => {
      await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_proxies_servers_toast_updated()
          : m.admin_proxies_servers_toast_created(),
      });
      await onSuccess({ token });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_toast_error(),
      });
    },
  });

  const form = useServerForm(server, async (values) => {
    await mutation.mutateAsync(values);
  });

  return { form, isEdit };
}
