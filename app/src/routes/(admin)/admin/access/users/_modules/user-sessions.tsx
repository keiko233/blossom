import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { describeSessionUserAgent } from "@/lib/session-display";
import { m } from "@/paraglide/messages";
import {
  listUserSessions,
  revokeUserSession,
  revokeUserSessions,
  USERS_QUERY_KEY,
} from "@/query/users";

export interface UserSessionsProps {
  userId: string;
}

/** Active sessions of one user, with revoke-one and revoke-all. */
export function UserSessions({
  userId,
}: UserSessionsProps): React.ReactElement {
  const queryClient = useQueryClient();

  const queryKey = [...USERS_QUERY_KEY, userId, "sessions"] as const;
  const { data: sessions, isPending } = useQuery({
    queryKey,
    queryFn: () => listUserSessions({ data: { id: userId } }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const onError = () => {
    toastManager.add({ type: "error", title: m.admin_users_toast_error() });
  };

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) =>
      revokeUserSession({ data: { userId, sessionId } }),
    onSuccess: async () => {
      await refresh();
      toastManager.add({
        type: "success",
        title: m.admin_users_sessions_toast_revoked(),
      });
    },
    onError,
  });

  const revokeAllMutation = useMutation({
    mutationFn: () => revokeUserSessions({ data: { id: userId } }),
    onSuccess: async () => {
      await refresh();
      toastManager.add({
        type: "success",
        title: m.admin_users_sessions_toast_revoked_all(),
      });
    },
    onError,
  });

  const requestRevoke = async (sessionId: string) => {
    await Confirm.call({
      title: m.admin_users_sessions_revoke_title(),
      description: m.admin_users_sessions_revoke_description(),
      confirmLabel: m.admin_users_sessions_revoke(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: () => revokeMutation.mutateAsync(sessionId),
    });
  };

  const requestRevokeAll = async () => {
    await Confirm.call({
      title: m.admin_users_sessions_revoke_all_title(),
      description: m.admin_users_sessions_revoke_all_description(),
      confirmLabel: m.admin_users_sessions_revoke_all(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: () => revokeAllMutation.mutateAsync(),
    });
  };

  const hasRevocable = (sessions ?? []).some((session) => !session.isCurrent);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">
          {m.admin_users_sessions_title()}
        </h2>
        <Button
          disabled={!hasRevocable}
          loading={revokeAllMutation.isPending}
          variant="outline"
          onClick={() => void requestRevokeAll()}
        >
          {m.admin_users_sessions_revoke_all()}
        </Button>
      </div>
      {isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : sessions && sessions.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.admin_users_sessions_col_client()}</TableHead>
              <TableHead>{m.admin_users_sessions_col_ip()}</TableHead>
              <TableHead>{m.admin_users_sessions_col_created()}</TableHead>
              <TableHead>{m.admin_users_sessions_col_expires()}</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.id}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">
                      {describeSessionUserAgent(session.userAgent) ??
                        m.admin_users_sessions_unknown()}
                    </span>
                    {session.isCurrent ? (
                      <Badge variant="outline">
                        {m.admin_users_sessions_current()}
                      </Badge>
                    ) : null}
                    {session.impersonated ? (
                      <Badge variant="outline">
                        {m.admin_users_sessions_impersonated()}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {session.ipAddress ?? m.admin_users_sessions_unknown()}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(session.createdAt)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(session.expiresAt)}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      disabled={session.isCurrent}
                      loading={
                        revokeMutation.isPending &&
                        revokeMutation.variables === session.id
                      }
                      size="sm"
                      variant="ghost"
                      onClick={() => void requestRevoke(session.id)}
                    >
                      {m.admin_users_sessions_revoke()}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {m.admin_users_sessions_empty()}
        </div>
      )}
    </div>
  );
}
