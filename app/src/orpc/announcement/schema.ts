import { z } from "zod";

import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_LEVELS,
} from "@/db/announcement-schema";

/**
 * Announcement input schemas. `planIds` is trimmed and de-duplicated here;
 * cross-field rules live in `getAnnouncementIssues` so `updateAnnouncement`
 * can re-run them against the merged row when only some fields are submitted.
 */

export const announcementLevelSchema = z.enum(ANNOUNCEMENT_LEVELS);
export const announcementAudienceSchema = z.enum(ANNOUNCEMENT_AUDIENCES);

export interface AnnouncementIssue {
  path: "planIds" | "endsAt";
  message: string;
}

/**
 * Cross-field validation over whichever fields are present. Issues for a
 * combination are only reported when all of its sides are known.
 */
export function getAnnouncementIssues(announcement: {
  audience?: z.infer<typeof announcementAudienceSchema>;
  planIds?: readonly string[];
  startsAt?: Date | null;
  endsAt?: Date | null;
}): AnnouncementIssue[] {
  const issues: AnnouncementIssue[] = [];
  if (
    announcement.audience === "plan" &&
    announcement.planIds !== undefined &&
    announcement.planIds.length === 0
  ) {
    issues.push({
      path: "planIds",
      message: "Choose at least one plan for this audience",
    });
  }
  if (
    announcement.startsAt &&
    announcement.endsAt &&
    announcement.endsAt.getTime() <= announcement.startsAt.getTime()
  ) {
    issues.push({
      path: "endsAt",
      message: "End time must be after start time",
    });
  }
  return issues;
}

function addAnnouncementIssues(
  announcement: Parameters<typeof getAnnouncementIssues>[0],
  ctx: z.RefinementCtx,
): void {
  for (const issue of getAnnouncementIssues(announcement)) {
    ctx.addIssue({
      code: "custom",
      path: [issue.path],
      message: issue.message,
    });
  }
}

const announcementFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  level: announcementLevelSchema,
  audience: announcementAudienceSchema,
  planIds: z
    .array(z.string().trim().min(1).max(255))
    .transform((ids) => [...new Set(ids)])
    .pipe(z.array(z.string()).max(200)),
  pinned: z.boolean(),
  published: z.boolean(),
  startsAt: z.date().nullable(),
  endsAt: z.date().nullable(),
});

export const createAnnouncementSchema = announcementFieldsSchema
  .extend({
    level: announcementFieldsSchema.shape.level.default("info"),
    audience: announcementFieldsSchema.shape.audience.default("all"),
    planIds: announcementFieldsSchema.shape.planIds.default([]),
    pinned: announcementFieldsSchema.shape.pinned.default(false),
    published: announcementFieldsSchema.shape.published.default(false),
    startsAt: announcementFieldsSchema.shape.startsAt.default(null),
    endsAt: announcementFieldsSchema.shape.endsAt.default(null),
  })
  .superRefine(addAnnouncementIssues);

export const updateAnnouncementSchema = announcementFieldsSchema
  .partial()
  .extend({ id: z.string().min(1) })
  .superRefine(addAnnouncementIssues);

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

export const announcementIdSchema = z.object({ id: z.string().min(1) });
