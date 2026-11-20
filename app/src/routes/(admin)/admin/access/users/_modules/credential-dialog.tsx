import { CopyIcon } from "lucide-react";
import { useState } from "react";
import { createCallable } from "react-call";

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
import { m } from "@/paraglide/messages";

/** Matches the dialog popup's exit animation before react-call unmounts it. */
const EXIT_MS = 200;

export interface CredentialDialogProps {
  uuid: string;
  password: string;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [isCopying, setIsCopying] = useState(false);

  const copy = async () => {
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({
        type: "success",
        title: m.admin_users_credentials_copied(),
      });
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/32 p-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Copy"
          loading={isCopying}
          onClick={() => void copy()}
        >
          <CopyIcon />
        </Button>
      </div>
    </div>
  );
}

/**
 * Shows a subscription's proxy credentials: `await CredentialDialog.call({...})`.
 * Unlike the one-time agent token reveal, credentials are stored in plaintext
 * (sing-box needs the raw secret), so this dialog can be reopened at any time.
 */
export const CredentialDialog = createCallable<CredentialDialogProps, void>(
  ({ call, uuid, password }) => (
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
          <DialogTitle>{m.admin_users_credentials_title()}</DialogTitle>
          <DialogDescription>
            {m.admin_users_credentials_description()}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6">
          <CopyRow label={m.admin_users_credentials_uuid()} value={uuid} />
          <CopyRow
            label={m.admin_users_credentials_password()}
            value={password}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button />}>
            {m.admin_users_credentials_done()}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  EXIT_MS,
);
