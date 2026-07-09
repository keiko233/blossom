import { useMutation } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import { banUser, setUserRole, unbanUser } from "@/lib/users";
import { m } from "@/paraglide/messages";

import { BanUserDialog } from "./ban-user-dialog";

interface TargetUser {
  id: string;
  role: string | null;
}

/**
 * Ban/unban/role mutations shared by the user list and detail pages. The
 * caller passes its own cache invalidation; toasts are handled here.
 */
export function useUserActions(onChanged: () => Promise<unknown>) {
  const onError = () => {
    toastManager.add({ type: "error", title: m.admin_users_toast_error() });
  };

  const banMutation = useMutation({
    mutationFn: (input: {
      userId: string;
      reason?: string;
      expiresInDays?: number;
    }) => banUser({ data: input }),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_banned(),
      });
    },
    onError,
  });

  const unbanMutation = useMutation({
    mutationFn: (id: string) => unbanUser({ data: { id } }),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_unbanned(),
      });
    },
    onError,
  });

  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: "admin" | "user" }) =>
      setUserRole({ data: input }),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_role_updated(),
      });
    },
    onError,
  });

  const requestBan = async (user: TargetUser) => {
    const params = await BanUserDialog.call();
    if (params) {
      banMutation.mutate({ userId: user.id, ...params });
    }
  };

  const toggleRole = (user: TargetUser) => {
    roleMutation.mutate({
      userId: user.id,
      role: user.role === "admin" ? "user" : "admin",
    });
  };

  return {
    requestBan,
    unban: (user: TargetUser) => unbanMutation.mutate(user.id),
    toggleRole,
  };
}
