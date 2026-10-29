import { useMutation, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import {
  parseIntInRange,
  REDEEM_CODES_PER_REQUEST_MAX,
} from "@/lib/redeem-batch";
import { m } from "@/paraglide/messages";
import { addRedeemCodes, REDEEM_QUERY_KEY } from "@/query/redeem";

import { CodesRevealDialog } from "./codes-reveal-dialog";

const FORM_ID = "redeem-add-codes-form";

export interface AddCodesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batchId: string;
}

/** Generates more codes for a batch, then opens the one-time reveal. */
export function AddCodesDialog({
  open,
  onOpenChange,
  batchId,
}: AddCodesDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <AddCodesForm batchId={batchId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddCodesForm({
  batchId,
  onDone,
}: {
  batchId: string;
  onDone: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [count, setCount] = useState("10");
  const [error, setError] = useState<string>();

  const mutation = useMutation({
    mutationFn: (parsed: number) =>
      addRedeemCodes({ data: { batchId, count: parsed } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: REDEEM_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: m.admin_redeem_toast_codes_added({ count: result.codes.length }),
      });
      onDone();
      void CodesRevealDialog.call({
        codes: result.codes,
        batchName: result.batchName,
      });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_redeem_toast_error() });
    },
  });

  const submit = () => {
    const parsed = parseIntInRange(count, 1, REDEEM_CODES_PER_REQUEST_MAX);
    if (parsed === null) {
      setError(
        m.admin_redeem_validation_number({
          min: 1,
          max: REDEEM_CODES_PER_REQUEST_MAX,
        }),
      );
      return;
    }
    setError(undefined);
    mutation.mutate(parsed);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{m.admin_redeem_add_title()}</DialogTitle>
        <DialogDescription>
          {m.admin_redeem_add_description()}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }}
        >
          <Field>
            <FieldLabel>{m.admin_redeem_field_code_count()}</FieldLabel>
            <Input inputMode="numeric" value={count} onValueChange={setCount} />
            <FieldDescription>
              {m.admin_redeem_field_code_count_hint({
                max: REDEEM_CODES_PER_REQUEST_MAX,
              })}
            </FieldDescription>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </Field>
        </form>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {m.admin_redeem_cancel()}
        </DialogClose>
        <Button type="submit" form={FORM_ID} loading={mutation.isPending}>
          {m.admin_redeem_add_submit()}
        </Button>
      </DialogFooter>
    </>
  );
}
