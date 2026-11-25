import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { totalRedeemUses } from "@/lib/redeem-batch";
import { redeemDetailSearchSchema } from "@/lib/redeem-search";
import { m } from "@/paraglide/messages";
import {
  deleteRedeemBatch,
  getRedeemBatch,
  REDEEM_QUERY_KEY,
  updateRedeemBatch,
} from "@/query/redeem";

import { AddCodesDialog } from "./_modules/add-codes-dialog";
import { BatchCodesTable } from "./_modules/batch-codes-table";
import { BatchRedemptionsTable } from "./_modules/batch-redemptions-table";
import { BatchSettingsCard } from "./_modules/batch-settings-card";
import { RedeemStatusBadge } from "./_modules/redeem-labels";

export const Route = createFileRoute("/(admin)/admin/access/redeem/$batchId")({
  validateSearch: redeemDetailSearchSchema,
  staticData: {
    crumb: () => m.admin_redeem_detail_crumb(),
  },
  component: RouteComponent,
});

function RouteComponent(): React.ReactElement {
  const { batchId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const {
    data: batch,
    isPending,
    error,
  } = useQuery({
    queryKey: [...REDEEM_QUERY_KEY, "batch", batchId],
    queryFn: () => getRedeemBatch({ data: { id: batchId } }),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: REDEEM_QUERY_KEY });

  const toggleMutation = useMutation({
    mutationFn: (disabled: boolean) =>
      updateRedeemBatch({ data: { id: batchId, disabled } }),
    onSuccess: async () => {
      await invalidate();
      toastManager.add({
        type: "success",
        title: m.admin_redeem_toast_updated(),
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_redeem_toast_error() });
    },
  });

  if (isPending) {
    return (
      <div className="flex min-w-0 flex-col [--page-toolbar-h:0rem]">
        <PageHeader>
          <Skeleton className="h-5 w-40" />
        </PageHeader>
        <PageContent>
          <Skeleton className="h-4 w-72" />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <TableSkeleton columns={5} rows={8} />
            <TableSkeleton columns={3} rows={6} />
          </div>
        </PageContent>
      </div>
    );
  }

  if (error || !batch) {
    return (
      <div className="flex min-w-0 flex-col [--page-toolbar-h:0rem]">
        <PageHeader>
          <PageHeaderTitle>{m.admin_redeem_detail_crumb()}</PageHeaderTitle>
        </PageHeader>
        <PageContent>
          <Alert variant="error">
            <AlertDescription>{m.admin_redeem_detail_error()}</AlertDescription>
          </Alert>
          <Button
            className="w-fit"
            render={<Link to="/admin/access/redeem" />}
            variant="outline"
          >
            <ArrowLeftIcon />
            {m.admin_redeem_back()}
          </Button>
        </PageContent>
      </div>
    );
  }

  const requestDelete = async () => {
    await Confirm.call({
      title: m.admin_redeem_delete_title(),
      description: m.admin_redeem_delete_description({ name: batch.name }),
      confirmLabel: m.admin_redeem_delete_confirm(),
      cancelLabel: m.admin_redeem_cancel(),
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteRedeemBatch({ data: { id: batch.id } });
          await invalidate();
          toastManager.add({
            type: "success",
            title: m.admin_redeem_toast_deleted(),
          });
          void navigate({ to: "/admin/access/redeem" });
        } catch (deleteError) {
          toastManager.add({
            type: "error",
            title: m.admin_redeem_toast_error(),
          });
          throw deleteError;
        }
      },
    });
  };

  return (
    <div className="flex min-w-0 flex-col [--page-toolbar-h:0rem]">
      <PageHeader>
        <div className="flex items-center gap-3">
          <Button
            aria-label={m.admin_redeem_back()}
            render={<Link to="/admin/access/redeem" />}
            size="icon"
            variant="ghost"
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>{batch.name}</PageHeaderTitle>
          <RedeemStatusBadge status={batch.status} />
        </div>
        <PageHeaderActions>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            {m.admin_redeem_add_codes()}
          </Button>
          <Button
            loading={toggleMutation.isPending}
            size="sm"
            variant="outline"
            onClick={() => toggleMutation.mutate(!batch.disabled)}
          >
            {batch.disabled
              ? m.admin_redeem_action_enable()
              : m.admin_redeem_action_disable()}
          </Button>
          {batch.redemptionCount === 0 ? (
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={() => void requestDelete()}
            >
              {m.admin_redeem_action_delete()}
            </Button>
          ) : null}
        </PageHeaderActions>
      </PageHeader>

      <PageContent>
        <p className="text-sm text-muted-foreground">
          {m.admin_redeem_detail_summary({
            codes: batch.codeCount,
            redeemed: batch.redeemed,
            total: totalRedeemUses(
              batch.codeCount,
              batch.maxRedemptionsPerCode,
            ),
          })}
          {batch.redemptionCount > 0
            ? ` ${m.admin_redeem_detail_delete_hint()}`
            : ""}
        </p>

        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <BatchCodesTable
              batchId={batch.id}
              maxRedemptionsPerCode={batch.maxRedemptionsPerCode}
              search={search}
            />
            <BatchRedemptionsTable batchId={batch.id} search={search} />
          </div>
          <BatchSettingsCard
            key={`${batch.id}-${batch.updatedAt.getTime()}`}
            batch={batch}
          />
        </div>
      </PageContent>

      <AddCodesDialog
        batchId={batch.id}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}
