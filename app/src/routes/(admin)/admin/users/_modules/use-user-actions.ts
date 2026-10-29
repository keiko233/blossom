import { useMutation } from "@tanstack/react-query";

import { Confirm } from "@/components/ui/confirm";
import { toastManager } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import {
  banUser,
  deleteUser,
  impersonateUser,
  sendUserSignInLink,
  setUserPassword,
  setUserRole,
  type SignInLinkStatus,
  unbanUser,
  updateUser,
} from "@/query/users";

import { BanUserDialog } from "./ban-user-dialog";
import { EditUserDialog } from "./edit-user-dialog";
import { SetPasswordDialog } from "./set-password-dialog";

interface TargetUser {
  id: string;
  role: string | null;
}

interface EditableUser extends TargetUser {
  name: string;
  email: string;
  emailVerified: boolean;
}

/** Toast for the outcome of asking the server to email a sign-in link. */
export function toastSignInLinkStatus(status: SignInLinkStatus | "failed") {
  if (status === "sent") {
    toastManager.add({
      type: "success",
      title: m.admin_users_toast_link_sent(),
    });
  } else if (status === "email_disabled") {
    toastManager.add({
      type: "warning",
      title: m.admin_users_toast_link_disabled(),
      description: m.admin_users_toast_link_disabled_hint(),
    });
  } else {
    toastManager.add({
      type: "error",
      title: m.admin_users_toast_link_failed(),
    });
  }
}

/**
 * Per-user mutations shared by the user list and detail pages. The caller
 * passes its own cache invalidation; toasts are handled here.
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

  const updateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      name: string;
      email: string;
      emailVerified: boolean;
    }) => updateUser({ data: input }),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_updated(),
      });
    },
    onError,
  });

  const passwordMutation = useMutation({
    mutationFn: (input: { id: string; password: string }) =>
      setUserPassword({ data: input }),
    onSuccess: () => {
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_password_set(),
      });
    },
    onError,
  });

  const signInLinkMutation = useMutation({
    mutationFn: (id: string) => sendUserSignInLink({ data: { id } }),
    onSuccess: (result) => toastSignInLinkStatus(result.status),
    onError,
  });

  const impersonateMutation = useMutation({
    mutationFn: (id: string) => impersonateUser({ data: { id } }),
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUser({ data: { id } }),
    onSuccess: async () => {
      await onChanged();
      toastManager.add({
        type: "success",
        title: m.admin_users_toast_deleted(),
      });
    },
    onError,
  });

  const requestBan = async (user: TargetUser) => {
    await BanUserDialog.call({
      onBan: (params) =>
        banMutation.mutateAsync({ userId: user.id, ...params }),
    });
  };

  const toggleRole = (user: TargetUser) => {
    roleMutation.mutate({
      userId: user.id,
      role: user.role === "admin" ? "user" : "admin",
    });
  };

  const requestEdit = async (user: EditableUser) => {
    await EditUserDialog.call({
      user,
      onSave: (result) =>
        updateMutation.mutateAsync({ id: user.id, ...result }),
    });
  };

  const requestSetPassword = async (user: TargetUser) => {
    await SetPasswordDialog.call({
      onSubmit: (password) =>
        passwordMutation.mutateAsync({ id: user.id, password }),
    });
  };

  /**
   * Starts an impersonation session and lands on the user app as that user.
   * A full page load, so the router re-reads the (now different) session.
   */
  const requestImpersonate = async (user: TargetUser & { name: string }) => {
    const confirmed = await Confirm.call({
      title: m.admin_users_impersonate_title({ name: user.name }),
      description: m.admin_users_impersonate_description(),
      confirmLabel: m.admin_users_impersonate_confirm(),
      cancelLabel: m.admin_users_form_cancel(),
      onConfirm: () => impersonateMutation.mutateAsync(user.id),
    });
    if (confirmed) {
      window.location.assign("/dashboard");
    }
  };

  /** Resolves true once the user is deleted (so the caller can navigate away). */
  const requestDelete = (user: TargetUser & { name: string }) =>
    Confirm.call({
      title: m.admin_users_delete_title({ name: user.name }),
      description: m.admin_users_delete_description(),
      confirmLabel: m.admin_users_delete_confirm(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(user.id),
    });

  return {
    requestBan,
    unban: (user: TargetUser) => unbanMutation.mutate(user.id),
    toggleRole,
    requestEdit,
    requestSetPassword,
    sendSignInLink: (user: TargetUser) => signInLinkMutation.mutate(user.id),
    requestImpersonate,
    requestDelete,
    pendingUserId: banMutation.isPending
      ? banMutation.variables?.userId
      : unbanMutation.isPending
        ? unbanMutation.variables
        : roleMutation.isPending
          ? roleMutation.variables?.userId
          : signInLinkMutation.isPending
            ? signInLinkMutation.variables
            : deleteMutation.isPending
              ? deleteMutation.variables
              : undefined,
  };
}
