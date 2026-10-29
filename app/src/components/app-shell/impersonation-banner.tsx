import { UserRoundCogIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages";

export interface ImpersonationBannerProps {
  /** The user being impersonated (the session's own user). */
  user: { id: string; name: string; email: string };
}

/**
 * Pinned notice while an admin views the app as another user. Stopping swaps
 * the admin's own session back in (better-auth restores it from the cookie it
 * parked at impersonation start) and returns to that user's admin page. A full
 * page load, so the router re-reads the restored session.
 */
export function ImpersonationBanner({ user }: ImpersonationBannerProps) {
  const [isStopping, setIsStopping] = useState(false);

  const stop = async () => {
    setIsStopping(true);
    try {
      const { error } = await authClient.admin.stopImpersonating();
      if (error) {
        throw new Error(error.message);
      }
      window.location.assign(`/admin/users/${encodeURIComponent(user.id)}`);
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_users_impersonation_stop_error(),
      });
      setIsStopping(false);
    }
  };

  return (
    <div
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-xl border border-warning/32 bg-card px-4 py-3 text-sm shadow-lg"
      role="status"
    >
      <UserRoundCogIcon aria-hidden="true" className="size-4 text-warning" />
      <span className="min-w-0 flex-1 truncate">
        {m.admin_users_impersonation_banner({
          name: user.name,
          email: user.email,
        })}
      </span>
      <Button
        loading={isStopping}
        size="sm"
        variant="outline"
        onClick={() => void stop()}
      >
        {m.admin_users_impersonation_stop()}
      </Button>
    </div>
  );
}
