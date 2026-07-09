import { CopyIcon } from "lucide-react";
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

const EXIT_MS = 200;

export interface SubscriptionLinkDialogProps {
  url: string;
}

export const SubscriptionLinkDialog = createCallable<
  SubscriptionLinkDialogProps,
  void
>(({ call, url }) => {
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    toastManager.add({
      type: "success",
      title: m.admin_users_subs_link_copied(),
    });
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
          <DialogTitle>{m.admin_users_subs_link_title()}</DialogTitle>
          <DialogDescription>
            {m.admin_users_subs_link_description()}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              URL
            </span>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/32 p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {url}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label="Copy"
                onClick={() => void copy()}
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button />}>
            {m.admin_users_credentials_done()}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}, EXIT_MS);
