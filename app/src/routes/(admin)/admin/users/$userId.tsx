import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CopyIcon,
  EllipsisIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
} from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  SubscriptionQuotaUsage,
  SubscriptionStatusBadge,
  SubscriptionTrafficTable,
} from "@/components/subscriptions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
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
import type { SubscriptionStatus } from "@/db/plan-schema";
import { m } from "@/paraglide/messages";
import {
  createSubscription,
  deleteSubscription,
  refreshSubscriptionToken,
  resetSubscriptionCredentials,
  updateSubscription,
} from "@/query/subscriptions";
import { getUserDetail, USERS_QUERY_KEY } from "@/query/users";

import { AccessLogDialog } from "./_modules/access-log-dialog";
import { AssignPlanDialog } from "./_modules/assign-plan-dialog";
import { CredentialDialog } from "./_modules/credential-dialog";
import { EditSubscriptionDialog } from "./_modules/edit-subscription-dialog";
import { SubscriptionLinkDialog } from "./_modules/subscription-link-dialog";
import { useUserActions } from "./_modules/use-user-actions";

export const Route = createFileRoute("/(admin)/admin/users/$userId")({
  staticData: {
    crumb: () => m.admin_users_detail_title(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const { userId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [copyingSubscriptionId, setCopyingSubscriptionId] = useState<
    string | null
  >(null);

  const detailQueryKey = [...USERS_QUERY_KEY, userId] as const;
  const { data: detail, isPending } = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => getUserDetail({ data: { id: userId } }),
  });

  // Prefix-invalidating the list key refreshes this detail query too.
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });

  const actions = useUserActions(invalidate);

  const onError = () => {
    toastManager.add({ type: "error", title: m.admin_users_toast_error() });
  };

  const assignMutation = useMutation({
    mutationFn: (planId: string) =>
      createSubscription({ data: { userId, planId } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_created(),
      });
    },
    onError,
  });

  const updateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      status: SubscriptionStatus;
      expiresAt: string;
    }) => updateSubscription({ data: input }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_updated(),
      });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSubscription({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_deleted(),
      });
    },
    onError,
  });

  const resetMutation = useMutation({
    mutationFn: (id: string) => resetSubscriptionCredentials({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_reset(),
      });
    },
    onError,
  });

  const refreshLinkMutation = useMutation({
    mutationFn: (id: string) => refreshSubscriptionToken({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_link_refreshed(),
      });
    },
    onError,
  });

  const requestAssign = async () => {
    await AssignPlanDialog.call({
      onAssign: (planId) => assignMutation.mutateAsync(planId),
    });
  };

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

  const requestDelete = async (subscriptionId: string) => {
    await Confirm.call({
      title: m.admin_users_subs_delete_title(),
      description: m.admin_users_subs_delete_description(),
      confirmLabel: m.admin_users_subs_action_delete(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(subscriptionId),
    });
  };

  const requestReset = async (subscriptionId: string) => {
    let credentials:
      | { credentialUuid: string; credentialPassword: string }
      | undefined;
    await Confirm.call({
      title: m.admin_users_subs_reset_title(),
      description: m.admin_users_subs_reset_description(),
      confirmLabel: m.admin_users_subs_action_reset_credentials(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: async () => {
        credentials = await resetMutation.mutateAsync(subscriptionId);
      },
    });
    if (credentials) {
      await CredentialDialog.call({
        uuid: credentials.credentialUuid,
        password: credentials.credentialPassword,
      });
    }
  };

  const requestCopyLink = async (sub: { id: string; token: string }) => {
    setCopyingSubscriptionId(sub.id);
    const url = `${window.location.origin}/api/sub/${sub.token}`;
    try {
      await navigator.clipboard.writeText(url);
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_link_copied(),
      });
    } finally {
      setCopyingSubscriptionId(null);
    }
  };

  const requestRefreshLink = async (subscriptionId: string) => {
    let token: string | undefined;
    await Confirm.call({
      title: m.admin_users_subs_refresh_link_title(),
      description: m.admin_users_subs_refresh_link_description(),
      confirmLabel: m.admin_users_subs_action_refresh_link(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: async () => {
        const row = await refreshLinkMutation.mutateAsync(subscriptionId);
        token = row.token;
      },
    });
    if (token) {
      await SubscriptionLinkDialog.call({
        url: `${window.location.origin}/api/sub/${token}`,
      });
    }
  };

  const viewAccessLogs = async (subscriptionId: string) => {
    await AccessLogDialog.call({
      subjectType: "subscription",
      subjectId: subscriptionId,
    });
  };

  if (isPending || !detail) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const { user, subscriptions, traffic } = detail;

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* User header card */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={m.admin_users_action_view()}
              onClick={() => void navigate({ to: "/admin/users" })}
            >
              <ArrowLeftIcon />
            </Button>
            <Avatar className="size-12">
              {user.image ? <AvatarImage src={user.image} /> : null}
              <AvatarFallback>
                {user.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-heading text-lg font-semibold">
                  {user.name}
                </span>
                {user.role === "admin" ? (
                  <Badge>{m.admin_users_role_admin()}</Badge>
                ) : null}
                {user.banned ? (
                  <Badge variant="outline">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-destructive"
                    />
                    {m.admin_users_status_banned()}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{user.email}</span>
                <Badge variant="outline">
                  {user.emailVerified
                    ? m.admin_users_detail_email_verified()
                    : m.admin_users_detail_email_unverified()}
                </Badge>
              </div>
              {user.banned ? (
                <div className="flex flex-col gap-0.5 text-xs text-destructive">
                  {user.banReason ? (
                    <span>
                      {m.admin_users_detail_ban_reason({
                        reason: user.banReason,
                      })}
                    </span>
                  ) : null}
                  {user.banExpires ? (
                    <span>
                      {m.admin_users_detail_ban_expires({
                        date: new Date(user.banExpires).toLocaleString(),
                      })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  loading={actions.pendingUserId === user.id}
                  size="icon"
                  variant="ghost"
                />
              }
              aria-label="Actions"
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => actions.toggleRole(user)}>
                {user.role === "admin"
                  ? m.admin_users_action_make_user()
                  : m.admin_users_action_make_admin()}
              </MenuItem>
              <MenuSeparator />
              {user.banned ? (
                <MenuItem onClick={() => actions.unban(user)}>
                  {m.admin_users_action_unban()}
                </MenuItem>
              ) : (
                <MenuItem
                  variant="destructive"
                  onClick={() => void actions.requestBan(user)}
                >
                  {m.admin_users_action_ban()}
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {/* Subscriptions */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold">
            {m.admin_users_subs_title()}
          </h2>
          <Button
            loading={assignMutation.isPending}
            onClick={() => void requestAssign()}
          >
            <PlusIcon />
            {m.admin_users_subs_assign()}
          </Button>
        </div>
        {subscriptions.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.admin_users_subs_col_plan()}</TableHead>
                <TableHead>{m.admin_users_subs_col_status()}</TableHead>
                <TableHead>{m.admin_users_subs_col_period()}</TableHead>
                <TableHead>{m.admin_users_subs_col_traffic()}</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.map(({ subscription: sub, planName }) => (
                <TableRow key={sub.id}>
                  <TableCell className="font-medium">{planName}</TableCell>
                  <TableCell>
                    <SubscriptionStatusBadge status={sub.status} />
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {new Date(sub.startedAt).toLocaleDateString()} –{" "}
                      {new Date(sub.expiresAt).toLocaleDateString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SubscriptionQuotaUsage
                      trafficQuotaBytes={sub.trafficQuotaBytes}
                      trafficUsedBytes={sub.trafficUsedBytes}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              loading={
                                (updateMutation.isPending &&
                                  updateMutation.variables?.id === sub.id) ||
                                (deleteMutation.isPending &&
                                  deleteMutation.variables === sub.id) ||
                                (resetMutation.isPending &&
                                  resetMutation.variables === sub.id) ||
                                (refreshLinkMutation.isPending &&
                                  refreshLinkMutation.variables === sub.id) ||
                                copyingSubscriptionId === sub.id
                              }
                              size="icon"
                              variant="ghost"
                            />
                          }
                          aria-label="Actions"
                        >
                          <EllipsisIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            onClick={() =>
                              void CredentialDialog.call({
                                uuid: sub.credentialUuid,
                                password: sub.credentialPassword,
                              })
                            }
                          >
                            {m.admin_users_subs_action_credentials()}
                          </MenuItem>
                          <MenuItem onClick={() => void requestReset(sub.id)}>
                            {m.admin_users_subs_action_reset_credentials()}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem onClick={() => void requestCopyLink(sub)}>
                            <span className="flex items-center gap-2">
                              <CopyIcon className="size-4" />
                              {m.admin_users_subs_action_copy_link()}
                            </span>
                          </MenuItem>
                          <MenuItem
                            onClick={() => void requestRefreshLink(sub.id)}
                          >
                            <span className="flex items-center gap-2">
                              <RefreshCwIcon className="size-4" />
                              {m.admin_users_subs_action_refresh_link()}
                            </span>
                          </MenuItem>
                          <MenuItem onClick={() => void viewAccessLogs(sub.id)}>
                            <span className="flex items-center gap-2">
                              <ScrollTextIcon className="size-4" />
                              {m.admin_users_subs_action_access_logs()}
                            </span>
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem onClick={() => void requestEdit(sub)}>
                            {m.admin_users_subs_action_edit()}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            onClick={() => void requestDelete(sub.id)}
                          >
                            {m.admin_users_subs_action_delete()}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {m.admin_users_subs_empty()}
          </div>
        )}
      </div>

      {/* Recent traffic */}
      <div className="flex flex-col gap-3">
        <h2 className="font-heading text-base font-semibold">
          {m.admin_users_traffic_title()}
        </h2>
        <SubscriptionTrafficTable
          records={traffic.map(({ record, nodeName, serverName }) => ({
            id: record.id,
            createdAt: record.createdAt,
            sourceName: nodeName ?? serverName,
            isServer: nodeName === null && serverName !== null,
            uplinkBytes: record.uplinkBytes,
            downlinkBytes: record.downlinkBytes,
          }))}
        />
      </div>
    </div>
  );
}
