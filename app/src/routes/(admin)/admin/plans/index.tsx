import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EllipsisIcon, PackageIcon, PlusIcon } from "lucide-react";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import {
  Empty,
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
import { formatAmount, formatTraffic } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  deletePlan,
  listPlans,
  type PlanListItem,
  PLANS_QUERY_KEY,
} from "@/query/plans";

export const Route = createFileRoute("/(admin)/admin/plans/")({
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
        title: error.message.includes("subscriptions")
          ? m.admin_plans_delete_blocked()
          : m.admin_plans_toast_error(),
      });
    },
  });

  const requestDelete = async (plan: PlanListItem) => {
    const confirmed = await Confirm.call({
      title: m.admin_plans_delete_title(),
      description: m.admin_plans_delete_description(),
      confirmLabel: m.admin_plans_action_delete(),
      cancelLabel: m.admin_plans_form_cancel(),
      destructive: true,
    });
    if (confirmed) {
      deleteMutation.mutate(plan.id);
    }
  };

  const openCreate = () => void navigate({ to: "/admin/plans/new" });

  const openEdit = (plan: PlanListItem) =>
    void navigate({
      to: "/admin/plans/$planId",
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
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
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
                render={<Button size="icon" variant="ghost" />}
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
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-semibold">
          {m.admin_nav_plans()}
        </h1>
        <Button onClick={openCreate}>
          <PlusIcon />
          {m.admin_plans_add()}
        </Button>
      </div>

      {isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : plans && plans.length > 0 ? (
        <Table>
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
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
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
          </EmptyHeader>
          <Button onClick={openCreate}>
            <PlusIcon />
            {m.admin_plans_add()}
          </Button>
        </Empty>
      )}
    </div>
  );
}
