import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  addUserNote,
  deleteUserNote,
  listUserNotes,
  USERS_QUERY_KEY,
} from "@/query/users";

export interface UserNotesProps {
  userId: string;
}

const NOTE_MAX_LENGTH = 2000;

/** Private admin notes about one user, newest first. */
export function UserNotes({ userId }: UserNotesProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const queryKey = [...USERS_QUERY_KEY, userId, "notes"] as const;
  const { data: notes, isPending } = useQuery({
    queryKey,
    queryFn: () => listUserNotes({ data: { id: userId } }),
  });

  const onError = () => {
    toastManager.add({ type: "error", title: m.admin_users_toast_error() });
  };

  const addMutation = useMutation({
    mutationFn: (body: string) => addUserNote({ data: { userId, body } }),
    onSuccess: async () => {
      setDraft("");
      await queryClient.invalidateQueries({ queryKey });
      toastManager.add({
        type: "success",
        title: m.admin_users_notes_toast_added(),
      });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUserNote({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      toastManager.add({
        type: "success",
        title: m.admin_users_notes_toast_deleted(),
      });
    },
    onError,
  });

  const requestDelete = async (id: string) => {
    await Confirm.call({
      title: m.admin_users_notes_delete_title(),
      description: m.admin_users_notes_delete_description(),
      confirmLabel: m.admin_users_notes_delete(),
      cancelLabel: m.admin_users_form_cancel(),
      destructive: true,
      onConfirm: () => deleteMutation.mutateAsync(id),
    });
  };

  const body = draft.trim();

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">
        {m.admin_users_notes_title()}
      </h2>
      <div className="flex flex-col items-end gap-2">
        <Textarea
          aria-label={m.admin_users_notes_placeholder()}
          maxLength={NOTE_MAX_LENGTH}
          placeholder={m.admin_users_notes_placeholder()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          disabled={body.length === 0}
          loading={addMutation.isPending}
          onClick={() => addMutation.mutate(body)}
        >
          {m.admin_users_notes_add()}
        </Button>
      </div>
      {isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : notes && notes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li
              className="flex items-start justify-between gap-3 rounded-xl border bg-card p-3 text-sm shadow-xs"
              key={note.id}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {note.authorName ?? m.admin_users_notes_author_unknown()} ·{" "}
                  {formatDateTime(note.createdAt)}
                </span>
                <p className="break-words whitespace-pre-wrap">{note.body}</p>
              </div>
              <Button
                aria-label={m.admin_users_notes_delete()}
                loading={
                  deleteMutation.isPending &&
                  deleteMutation.variables === note.id
                }
                size="icon"
                variant="ghost"
                onClick={() => void requestDelete(note.id)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {m.admin_users_notes_empty()}
        </div>
      )}
    </div>
  );
}
