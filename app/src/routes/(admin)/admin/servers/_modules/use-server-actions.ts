import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Confirm } from "@/components/ui/confirm";
import { toastManager } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import {
  deleteServer,
  SERVERS_QUERY_KEY,
  type ServerListItem,
} from "@/query/servers";

/**
 * Lifecycle actions for the selected server: copy the agent connection details
 * and delete the server. Credential changes go through the Connection tab so
 * every enable/reset/disable keeps its confirmation and one-time reveal.
 */
export function useServerActions(server: ServerListItem) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [copying, setCopying] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY });

  const deleteMutation = useMutation({
    mutationFn: () => deleteServer({ data: { id: server.id } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_toast_deleted(),
      });
      await navigate({ to: "/admin/servers" });
    },
    onError: (error: unknown) => {
      // The CRUD layer throws a clear "still has nodes" message; FK RESTRICT
      // beneath makes that robust. Surface it as a toast, not a generic error.
      const message = error instanceof Error ? error.message : String(error);
      toastManager.add({
        type: "error",
        title:
          message.includes("node") || message.includes("节点")
            ? m.admin_proxies_servers_toast_blocked()
            : m.admin_proxies_servers_toast_error(),
      });
    },
  });

  const requestDelete = async () => {
    if (server.nodeCount > 0) {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_toast_blocked(),
      });
      return;
    }

    await Confirm.call({
      title: m.admin_proxies_servers_delete_title(),
      description: m.admin_proxies_servers_delete_description(),
      confirmLabel: m.admin_proxies_servers_action_delete(),
      cancelLabel: m.admin_proxies_servers_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(),
    });
  };

  const copyAgentInfo = async () => {
    setCopying(true);
    const info = JSON.stringify(
      {
        serverId: server.id,
        address: server.address,
        tokenPrefix: server.agentTokenPrefix,
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(info);
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_toast_copied(),
      });
    } finally {
      setCopying(false);
    }
  };

  const isBusy = copying || deleteMutation.isPending;

  return {
    isBusy,
    copyAgentInfo,
    requestDelete,
  };
}
