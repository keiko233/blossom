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
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
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
import {
  createSubscription,
  deleteSubscription,
  refreshSubscriptionToken,
  resetSubscriptionCredentials,
  updateSubscription,
} from "@/lib/subscriptions";
import { getUserDetail, USERS_QUERY_KEY } from "@/lib/users";
import { m } from "@/paraglide/messages";

import { AccessLogDialog } from "./_modules/access-log-dialog";
import { AssignPlanDialog } from "./_modules/assign-plan-dialog";
import { CredentialDialog } from "./_modules/credential-dialog";
import { EditSubscriptionDialog } from "./_modules/edit-subscription-dialog";
import { SubscriptionLinkDialog } from "./_modules/subscription-link-dialog";
import { useUserActions } from "./_modules/use-user-actions";

export const Route = createFileRoute("/(admin)/admin/users/$userId")({
  component: RouteComponent,
});

const BYTES_PER_GB = 1024 ** 3;

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  }
  if (bytes < BYTES_PER_GB) {
    return `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  }
  const gb = bytes / BYTES_PER_GB;
  if (gb >= 1024) {
    return `${(gb / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  }
  return `${gb.toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`;
}

function subscriptionStatusBadge(status: SubscriptionStatus) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-emerald-500"
          />
          {m.admin_users_subs_status_active()}
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-muted-foreground/64"
          />
          {m.admin_users_subs_status_expired()}
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-destructive"
          />
          {m.admin_users_subs_status_cancelled()}
        </Badge>
      );
  }
}

function RouteComponent(): React.ReactElement {
  const { userId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

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
    onSuccess: async (row) => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_reset(),
      });
      await CredentialDialog.call({
        uuid: row.credentialUuid,
        password: row.credentialPassword,
      });
    },
    onError,
  });

  const refreshLinkMutation = useMutation({
    mutationFn: (id: string) => refreshSubscriptionToken({ data: { id } }),
    onSuccess: async (row) => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_users_subs_toast_link_refreshed(),
      });
      await SubscriptionLinkDialog.call({
        url: `${window.location.origin}/api/sub/${row.token}`,
      });
    },
    onError,
  });

  const requestAssign = async () => {
    const planId = await AssignPlanDialog.call();
    if (planId) {
      assignMutation.mutate(planId);
    }
  };

  const requestEdit = async (sub: {
    id: string;
    status: SubscriptionStatus;
    expiresAt: Date;
  }) => {
    const result = await EditSubscriptionDialog.call({
      status: sub.status,
      expiresAt: sub.expiresAt,
    });
    if (result) {
      updateMutation.mutate({ id: sub.id, ...result });
    }
  };

  const requestDelete = async (subscriptionId: string) => {
    const confirmed = await Confirm.call({
      title: m.admin_users_subs_delete_title(),
      description: m.admin_users_subs_delete_description(),
      confirmLabel: m.admin_users_subs_action_delete(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      deleteMutation.mutate(subscriptionId);
    }
  };

  const requestReset = async (subscriptionId: string) => {
    const confirmed = await Confirm.call({
      title: m.admin_users_subs_reset_title(),
      description: m.admin_users_subs_reset_description(),
      confirmLabel: m.admin_users_subs_action_reset_credentials(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      resetMutation.mutate(subscriptionId);
    }
  };

  const requestCopyLink = async (sub: { token: string }) => {
    const url = `${window.location.origin}/api/sub/${sub.token}`;
    await navigator.clipboard.writeText(url);
    toastManager.add({
      type: "success",
      title: m.admin_users_subs_link_copied(),
    });
  };

  const requestRefreshLink = async (subscriptionId: string) => {
    const confirmed = await Confirm.call({
      title: m.admin_users_subs_refresh_link_title(),
      description: m.admin_users_subs_refresh_link_description(),
      confirmLabel: m.admin_users_subs_action_refresh_link(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      refreshLinkMutation.mutate(subscriptionId);
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
              render={<Button size="icon" variant="ghost" />}
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
          <Button onClick={() => void requestAssign()}>
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
                  <TableCell>{subscriptionStatusBadge(sub.status)}</TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {new Date(sub.startedAt).toLocaleDateString()} –{" "}
                      {new Date(sub.expiresAt).toLocaleDateString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    {sub.trafficQuotaBytes === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(sub.trafficUsedBytes)} /{" "}
                        {m.admin_users_subs_traffic_unlimited()}
                      </span>
                    ) : (
                      <div className="flex min-w-36 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(sub.trafficUsedBytes)} /{" "}
                          {formatBytes(sub.trafficQuotaBytes)}
                        </span>
                        <Meter
                          value={sub.trafficUsedBytes}
                          max={sub.trafficQuotaBytes}
                        >
                          <MeterTrack className="rounded-full">
                            <MeterIndicator />
                          </MeterTrack>
                        </Meter>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Menu>
                        <MenuTrigger
                          render={<Button size="icon" variant="ghost" />}
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
        {traffic.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.admin_users_traffic_col_time()}</TableHead>
                <TableHead>{m.admin_users_traffic_col_node()}</TableHead>
                <TableHead>{m.admin_users_traffic_col_up()}</TableHead>
                <TableHead>{m.admin_users_traffic_col_down()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {traffic.map(({ record, nodeName }) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {new Date(record.createdAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    {nodeName ?? (
                      <span className="text-muted-foreground">
                        {m.admin_users_traffic_node_deleted()}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">
                      {formatBytes(record.uplinkBytes)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">
                      {formatBytes(record.downlinkBytes)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {m.admin_users_traffic_empty()}
          </div>
        )}
      </div>
    </div>
  );
}
