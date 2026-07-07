"use client";

import { createCallable } from "react-call";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** Matches the popup's exit animation so the dialog can play out before unmounting. */
const EXIT_MS = 200;

export interface ConfirmProps {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Style the confirm action as destructive (e.g. delete). */
  destructive?: boolean;
}

/**
 * Imperative confirmation dialog: `const ok = await Confirm.call({ ... })`.
 *
 * Render `<Confirm />` once high in the tree; each `call` pushes a dialog and
 * resolves with the user's choice. `call.ended` drives the controlled `open` so
 * base-ui plays its exit animation before react-call unmounts the item.
 */
export const Confirm = createCallable<ConfirmProps, boolean>(
  ({ call, title, description, confirmLabel, cancelLabel, destructive }) => (
    <AlertDialog
      open={!call.ended}
      onOpenChange={(open) => {
        if (!open && !call.ended) {
          call.end(false);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {cancelLabel}
          </AlertDialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => call.end(true)}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  EXIT_MS,
);
