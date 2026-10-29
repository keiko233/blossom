import { CopyIcon, DownloadIcon } from "lucide-react";
import { createCallable } from "react-call";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import { downloadCsv } from "@/lib/download-csv";
import { redeemCodesToCsv } from "@/lib/redeem-csv";
import { m } from "@/paraglide/messages";

/** Matches the dialog popup's exit animation before react-call unmounts it. */
const EXIT_MS = 200;

export interface CodesRevealProps {
  /** The one-time plaintext codes. */
  codes: readonly string[];
  batchName: string;
}

/**
 * Imperative one-time reveal of freshly generated redeem codes:
 * `await CodesRevealDialog.call({ codes, batchName })`.
 *
 * Only hashes are stored, so this is the only chance to copy or download the
 * codes. Render `<CodesRevealDialog />` once high in the tree (the redeem
 * section's route does).
 */
export const CodesRevealDialog = createCallable<CodesRevealProps, void>(
  ({ call, codes, batchName }) => {
    const copyAll = async () => {
      try {
        await navigator.clipboard.writeText(codes.join("\n"));
        toastManager.add({
          type: "success",
          title: m.admin_redeem_reveal_toast_copied({ count: codes.length }),
        });
      } catch {
        toastManager.add({
          type: "error",
          title: m.admin_redeem_reveal_toast_copy_error(),
        });
      }
    };

    const download = () => {
      downloadCsv(
        `redeem-codes-${new Date().toISOString().slice(0, 10)}.csv`,
        redeemCodesToCsv(codes, batchName),
      );
    };

    return (
      <Dialog
        open={!call.ended}
        onOpenChange={(open) => {
          if (!open && !call.ended) {
            call.end();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {m.admin_redeem_reveal_title({ count: codes.length })}
            </DialogTitle>
            <DialogDescription>
              {m.admin_redeem_reveal_description({ name: batchName })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6">
            <Alert variant="warning">
              <AlertTitle>{m.admin_redeem_reveal_warning_title()}</AlertTitle>
              <AlertDescription>
                {m.admin_redeem_reveal_warning()}
              </AlertDescription>
            </Alert>
            <textarea
              readOnly
              aria-label={m.admin_redeem_reveal_codes_label()}
              className="h-56 w-full resize-none rounded-lg border bg-muted/32 p-3 font-mono text-xs"
              value={codes.join("\n")}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={download}>
              <DownloadIcon />
              {m.admin_redeem_reveal_download()}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void copyAll()}
            >
              <CopyIcon />
              {m.admin_redeem_reveal_copy_all()}
            </Button>
            <DialogClose render={<Button />}>
              {m.admin_redeem_reveal_done()}
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
