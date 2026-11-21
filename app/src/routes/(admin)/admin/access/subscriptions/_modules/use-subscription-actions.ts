import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Confirm } from "@/components/ui/confirm";
import { toastManager } from "@/components/ui/toast";
import type { SubscriptionStatus } from "@/db/plan-schema";
import { m } from "@/paraglide/messages";
import {
  deleteSubscription,
  refreshSubscriptionToken,
  resetSubscriptionCredentials,
  updateSubscription,
} from "@/query/subscriptions";

import { CredentialDialog } from "../../users/_modules/credential-dialog";
import { EditSubscriptionDialog } from "../../users/_modules/edit-subscription-dialog";
import { SubscriptionLinkDialog } from "../../users/_modules/subscription-link-dialog";

/**
 * Per-subscription row actions for the hub, reusing the user detail page's
 * dialogs and server functions. `onChanged` runs after each successful
 * mutation (refetch the list).
 */
export function useSubscriptionActions(onChanged: () => Promise<unknown>) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  const onError = () => {
    toastManager.add({
      type: "error",
      title: m.admin_subscriptions_toast_error(),
    });
  };

  // Tracks which row is busy so only its menu button shows the spinner.
  const track = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
    setPendingId(id);
    try {
      return await run();
    } finally {
      setPendingId(null);
    }
  };

  const updateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      status: SubscriptionStatus;
      expiresAt: string;
    }) => track(input.id, () => updateSubscription({ data: input })),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_updated(),
      });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      track(id, () => deleteSubscription({ data: { id } })),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_deleted(),
      });
    },
    onError,
  });

  const resetMutation = useMutation({
    mutationFn: (id: string) =>
      track(id, () => resetSubscriptionCredentials({ data: { id } })),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_reset(),
      });
    },
    onError,
  });

  const refreshLinkMutation = useMutation({
    mutationFn: (id: string) =>
      track(id, () => refreshSubscriptionToken({ data: { id } })),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_link_refreshed(),
      });
    },
    onError,
  });

  const requestEdit = async (sub: {
    id: string;
    status: SubscriptionStatus;
    expiresAt: Date;
  }) => {
    await EditSubscriptionDialog.call({
      status: sub.status,
      expiresAt: sub.expiresAt,
      onSave: (result) => updateMutation.mutateAsync({ id: sub.id, ...result }),
    });
  };

  const requestDelete = async (id: string) => {
    await Confirm.call({
      title: m.admin_users_subs_delete_title(),
      description: m.admin_users_subs_delete_description(),
      confirmLabel: m.admin_users_subs_action_delete(),
      cancelLabel: m.admin_subscriptions_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(id),
    });
  };

  const requestReset = async (id: string) => {
    let credentials:
      | { credentialUuid: string; credentialPassword: string }
      | undefined;
    await Confirm.call({
      title: m.admin_users_subs_reset_title(),
      description: m.admin_users_subs_reset_description(),
      confirmLabel: m.admin_users_subs_action_reset_credentials(),
      cancelLabel: m.admin_subscriptions_cancel(),
      destructive: true,
      onConfirm: async () => {
        credentials = await resetMutation.mutateAsync(id);
      },
    });
    if (credentials) {
      await CredentialDialog.call({
        uuid: credentials.credentialUuid,
        password: credentials.credentialPassword,
      });
    }
  };

  const requestRefreshLink = async (id: string) => {
    let token: string | undefined;
    await Confirm.call({
      title: m.admin_users_subs_refresh_link_title(),
      description: m.admin_users_subs_refresh_link_description(),
      confirmLabel: m.admin_users_subs_action_refresh_link(),
      cancelLabel: m.admin_subscriptions_cancel(),
      destructive: true,
      onConfirm: async () => {
        const row = await refreshLinkMutation.mutateAsync(id);
        token = row.token;
      },
    });
    if (token) {
      await SubscriptionLinkDialog.call({
        url: `${window.location.origin}/api/sub/${token}`,
      });
    }
  };

  return {
    pendingId,
    requestEdit,
    requestDelete,
    requestReset,
    requestRefreshLink,
  };
}
