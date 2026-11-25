import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, PackageIcon, PlusIcon } from "lucide-react";
import type React from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import {
  type PlanDeleteBlocker,
  planDeleteBlockers,
} from "@/lib/access-impact";
import { formatAmount, formatTraffic } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { GROUPS_QUERY_KEY, listGroups } from "@/query/groups";
import {
  deletePlan,
  getPlanImpact,
  listPlans,
  type PlanListItem,
  PLANS_QUERY_KEY,
} from "@/query/plans";

export const Route = createFileRoute("/(admin)/admin/access/plans/")({
  component: RouteComponent,
});

const columnHelper = createColumnHelper<PlanListItem>();

function RouteComponent(): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: plans, isPending } = useQuery({
    queryKey: PLANS_QUERY_KEY,
    queryFn: () => listPlans(),
  });

  const { data: groups } = useQuery({
    queryKey: GROUPS_QUERY_KEY,
    queryFn: () => listGroups(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePlan({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLANS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_plans_toast_deleted(),
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: error.message.includes("trial plan")
          ? m.admin_plans_delete_blocked_trial()
          : error.message.includes("subscriptions")
            ? m.admin_plans_delete_blocked()
            : error.message.includes("redeem batches")
              ? m.admin_access_plan_delete_blocker_redeem_toast()
              : m.admin_plans_toast_error(),
      });
    },
  });

  const requestDelete = async (plan: PlanListItem) => {
    // Advisory read: the server re-checks these at delete time.
    const impact = await getPlanImpact({ data: { id: plan.id } }).catch(
      () => undefined,
    );
    const blockers = impact ? planDeleteBlockers(impact) : [];
    if (impact && blockers.length > 0) {
      const reason: Record<PlanDeleteBlocker, string> = {
        trial: m.admin_access_plan_delete_blocker_trial(),
        subscriptions: m.admin_access_plan_delete_blocker_subscriptions({
          count: impact.subscriptionCount,
        }),
        redeem_batches: m.admin_access_plan_delete_blocker_redeem({
          count: impact.redeemBatchCount,
        }),
      };
      // Nothing destructive to confirm: explain, and offer the way to the
      // subscriptions that are in the way.
      const viewSubscriptions =
        blockers.includes("subscriptions") && impact.subscriptionCount > 0;
      await Confirm.call({
        title: m.admin_access_plan_delete_blocked_title(),
        description: [
          m.admin_access_plan_delete_blocked_intro(),
          ...blockers.map((blocker) => reason[blocker]),
        ].join(" "),
        confirmLabel: viewSubscriptions
          ? m.admin_access_view_subscriptions()
          : m.admin_access_close(),
        cancelLabel: m.admin_access_close(),
        onConfirm: async () => {
          if (viewSubscriptions) {
            await navigate({
              to: "/admin/access/subscriptions",
              search: { plan: plan.id },
            });
          }
        },
      });
      return;
    }
    await Confirm.call({
      title: m.admin_plans_delete_title(),
      description: m.admin_plans_delete_description(),
      confirmLabel: m.admin_plans_action_delete(),
      cancelLabel: m.admin_plans_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(plan.id),
    });
  };

  const openEdit = (plan: PlanListItem) =>
    void navigate({
      to: "/admin/access/plans/$planId",
      params: { planId: plan.id },
    });

  const columns = [
    columnHelper.accessor("name", {
      header: () => m.admin_plans_col_name(),
      cell: (info) => {
        const plan = info.row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{plan.name}</span>
            {plan.description ? (
              <span className="text-xs text-muted-foreground">
                {plan.description}
              </span>
            ) : null}
          </div>
        );
      },
    }),
    columnHelper.accessor("priceCents", {
      header: () => m.admin_plans_col_price(),
      cell: (info) => (
        <span className="font-mono text-xs">
          {formatAmount(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor("durationDays", {
      header: () => m.admin_plans_col_duration(),
      cell: (info) => m.admin_plans_duration_days({ days: info.getValue() }),
    }),
    columnHelper.accessor("trafficBytes", {
      header: () => m.admin_plans_col_traffic(),
      cell: (info) => (
        <span className="font-mono text-xs">
          {formatTraffic(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor("deviceLimit", {
      header: () => m.admin_plans_col_devices(),
      cell: (info) =>
        info.getValue() === 0
          ? m.admin_plans_device_unlimited()
          : info.getValue(),
    }),
    columnHelper.accessor("groupCount", {
      header: () => m.admin_plans_col_groups(),
      cell: (info) =>
        info.getValue() === 0 ? (
          <Badge variant="warning" title={m.admin_access_plan_no_groups_hint()}>
            {m.admin_access_plan_no_groups()}
          </Badge>
        ) : (
          <Badge variant="outline">{info.getValue()}</Badge>
        ),
    }),
    columnHelper.accessor("subscriptionCount", {
      header: () => m.admin_plans_col_subscriptions(),
      cell: (info) =>
        info.getValue() === 0 ? (
          <Badge variant="outline">0</Badge>
        ) : (
          <Link
            className="underline-offset-4 hover:underline"
            search={{ plan: info.row.original.id }}
            to="/admin/access/subscriptions"
          >
            <Badge variant="outline">{info.getValue()}</Badge>
          </Link>
        ),
    }),
    columnHelper.accessor("visible", {
      header: () => m.admin_plans_col_visible(),
      cell: (info) =>
        info.getValue() ? (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-emerald-500"
            />
            {m.admin_plans_visible_on()}
          </Badge>
        ) : (
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-muted-foreground/64"
            />
            {m.admin_plans_visible_off()}
          </Badge>
        ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const plan = info.row.original;
        return (
          <div className="flex justify-end">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    loading={
                      deleteMutation.isPending &&
                      deleteMutation.variables === plan.id
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
                <MenuItem onClick={() => openEdit(plan)}>
                  {m.admin_plans_action_edit()}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() => void requestDelete(plan)}
                >
                  {m.admin_plans_action_delete()}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: plans ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex min-w-0 flex-col [--page-toolbar-h:0rem]">
      <PageHeader>
        <PageHeaderTitle>{m.admin_nav_plans()}</PageHeaderTitle>
        <PageHeaderActions>
          <Button size="sm" render={<Link to="/admin/access/plans/new" />}>
            <PlusIcon />
            {m.admin_plans_add()}
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <PageContent width="flush">
        {isPending ? (
          <TableSkeleton columns={8} rows={8} />
        ) : plans && plans.length > 0 ? (
          <Table variant="pane">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageIcon />
              </EmptyMedia>
              <EmptyTitle>{m.admin_plans_empty_title()}</EmptyTitle>
              <EmptyDescription>
                {groups && groups.length === 0
                  ? m.admin_access_plans_empty_need_groups()
                  : m.admin_access_plans_empty_description()}
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex flex-wrap justify-center gap-2">
              {groups && groups.length === 0 ? (
                <Button
                  variant="outline"
                  render={<Link to="/admin/access/groups/new" />}
                >
                  {m.admin_access_create_group()}
                </Button>
              ) : null}
              <Button render={<Link to="/admin/access/plans/new" />}>
                <PlusIcon />
                {m.admin_plans_add()}
              </Button>
            </div>
          </Empty>
        )}
      </PageContent>
    </div>
  );
}
