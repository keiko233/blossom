import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageHeader,
  PageHeaderTitle,
} from "@/components/app-shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Spinner } from "@/components/ui/spinner";
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

export const Route = createFileRoute("/(admin)/admin/redeem/$batchId")({
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
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (error || !batch) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Alert variant="error">
          <AlertDescription>{m.admin_redeem_detail_error()}</AlertDescription>
        </Alert>
        <Button
          className="w-fit"
          render={<Link to="/admin/redeem" />}
          variant="outline"
        >
          <ArrowLeftIcon />
          {m.admin_redeem_back()}
        </Button>
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
          void navigate({ to: "/admin/redeem" });
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
    <div className="flex flex-col gap-4 p-4">
      <PageHeader className="flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Button
            aria-label={m.admin_redeem_back()}
            render={<Link to="/admin/redeem" />}
            size="icon"
            variant="ghost"
          >
            <ArrowLeftIcon />
          </Button>
          <PageHeaderTitle>{batch.name}</PageHeaderTitle>
          <RedeemStatusBadge status={batch.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            {m.admin_redeem_add_codes()}
          </Button>
          <Button
            loading={toggleMutation.isPending}
            variant="outline"
            onClick={() => toggleMutation.mutate(!batch.disabled)}
          >
            {batch.disabled
              ? m.admin_redeem_action_enable()
              : m.admin_redeem_action_disable()}
          </Button>
          {batch.redemptionCount === 0 ? (
            <Button
              variant="destructive-outline"
              onClick={() => void requestDelete()}
            >
              {m.admin_redeem_action_delete()}
            </Button>
          ) : null}
        </div>
      </PageHeader>

      <p className="text-sm text-muted-foreground">
        {m.admin_redeem_detail_summary({
          codes: batch.codeCount,
          redeemed: batch.redeemed,
          total: totalRedeemUses(batch.codeCount, batch.maxRedemptionsPerCode),
        })}
        {batch.redemptionCount > 0
          ? ` ${m.admin_redeem_detail_delete_hint()}`
          : ""}
      </p>

      <BatchSettingsCard
        key={`${batch.id}-${batch.updatedAt.getTime()}`}
        batch={batch}
      />
      <BatchCodesTable
        batchId={batch.id}
        maxRedemptionsPerCode={batch.maxRedemptionsPerCode}
        search={search}
      />
      <BatchRedemptionsTable batchId={batch.id} search={search} />

      <AddCodesDialog
        batchId={batch.id}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}
