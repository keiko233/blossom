import { createCallable } from "react-call";

import { AccessLogTable } from "@/components/access-log-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";

const EXIT_MS = 200;

export interface AccessLogDialogProps {
  subjectType: string;
  subjectId: string;
}

export const AccessLogDialog = createCallable<AccessLogDialogProps, void>(
  ({ call, subjectType, subjectId }) => (
    <Dialog
      open={!call.ended}
      onOpenChange={(open) => {
        if (!open && !call.ended) {
          call.end();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.access_log_title()}</DialogTitle>
        </DialogHeader>
        <div className="px-6">
          <AccessLogTable subjectType={subjectType} subjectId={subjectId} />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {m.access_log_close()}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  EXIT_MS,
);
