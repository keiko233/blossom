import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import type {
  AnnouncementAudience,
  AnnouncementLevel,
} from "@/db/announcement-schema";
import { toDatetimeLocalValue } from "@/lib/format";
import { m } from "@/paraglide/messages";
import {
  ANNOUNCEMENTS_QUERY_KEY,
  type AnnouncementListItem,
  createAnnouncement,
  updateAnnouncement,
} from "@/query/announcements";

/** Date inputs hold `datetime-local` strings ("" when unset). */
export interface AnnouncementFormValues {
  title: string;
  body: string;
  level: AnnouncementLevel;
  audience: AnnouncementAudience;
  planIds: string[];
  pinned: boolean;
  published: boolean;
  startsAt: string;
  endsAt: string;
}

const TITLE_MAX = 200;
const BODY_MAX = 5000;

function defaultValues(
  announcement?: AnnouncementListItem,
): AnnouncementFormValues {
  return {
    title: announcement?.title ?? "",
    body: announcement?.body ?? "",
    level: announcement?.level ?? "info",
    audience: announcement?.audience ?? "all",
    planIds: announcement?.planIds ?? [],
    pinned: announcement?.pinned ?? false,
    published: announcement?.published ?? false,
    startsAt: announcement?.startsAt
      ? toDatetimeLocalValue(announcement.startsAt)
      : "",
    endsAt: announcement?.endsAt
      ? toDatetimeLocalValue(announcement.endsAt)
      : "",
  };
}

/** `datetime-local` values have no zone; `new Date` reads them as local time. */
function parseLocalDate(value: string): Date | null {
  return value ? new Date(value) : null;
}

function toPayload(v: AnnouncementFormValues) {
  return {
    title: v.title.trim(),
    body: v.body.trim(),
    level: v.level,
    audience: v.audience,
    // Plan ids only matter for the plan audience; keep the stored list clean.
    planIds: v.audience === "plan" ? v.planIds : [],
    pinned: v.pinned,
    published: v.published,
    startsAt: parseLocalDate(v.startsAt),
    endsAt: parseLocalDate(v.endsAt),
  };
}

/** Form-level validation with localized messages, keyed by field name. */
function validate(
  v: AnnouncementFormValues,
):
  | { fields: Partial<Record<keyof AnnouncementFormValues, string>> }
  | undefined {
  const title = v.title.trim();
  if (!title) {
    return { fields: { title: m.admin_announcements_validation_title() } };
  }
  if (title.length > TITLE_MAX) {
    return {
      fields: { title: m.admin_announcements_validation_title_length() },
    };
  }
  const body = v.body.trim();
  if (!body) {
    return { fields: { body: m.admin_announcements_validation_body() } };
  }
  if (body.length > BODY_MAX) {
    return { fields: { body: m.admin_announcements_validation_body_length() } };
  }
  if (v.audience === "plan" && v.planIds.length === 0) {
    return { fields: { planIds: m.admin_announcements_validation_plans() } };
  }
  const startsAt = parseLocalDate(v.startsAt);
  const endsAt = parseLocalDate(v.endsAt);
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    return { fields: { endsAt: m.admin_announcements_validation_window() } };
  }
  return undefined;
}

export interface UseAnnouncementFormOptions {
  /** Present when editing; absent for create. */
  announcement?: AnnouncementListItem;
  onSuccess: () => void;
}

/**
 * Owns the create/update mutation and the form instance for the announcement
 * dialog. The dialog body mounts per open, so fresh default values apply each
 * time.
 */
export function useAnnouncementForm({
  announcement,
  onSuccess,
}: UseAnnouncementFormOptions) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(announcement);

  const mutation = useMutation({
    mutationFn: async (values: AnnouncementFormValues) => {
      const payload = toPayload(values);
      if (announcement) {
        await updateAnnouncement({ data: { id: announcement.id, ...payload } });
      } else {
        await createAnnouncement({ data: payload });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ANNOUNCEMENTS_QUERY_KEY,
      });
      toastManager.add({
        type: "success",
        title: isEdit
          ? m.admin_announcements_toast_updated()
          : m.admin_announcements_toast_created(),
      });
      onSuccess();
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: m.admin_announcements_toast_error(),
      });
    },
  });

  const form = useForm({
    defaultValues: defaultValues(announcement),
    validators: { onSubmit: ({ value }) => validate(value) },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // onError already reported it; keep the dialog open for a retry.
      }
    },
  });

  return { form, isEdit };
}
