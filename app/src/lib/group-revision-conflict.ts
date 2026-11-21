/**
 * Client-safe half of the group revision conflict contract.
 *
 * `updateGroup` / `deleteGroup` throw `GroupMembershipConflictError`
 * (`query/group-membership-write.ts`, server-only) when `expectedRevision` is
 * stale. TanStack Start serializes thrown errors with seroval: the client
 * receives a plain `Error` carrying `name`, `message` and the own properties
 * `code`, `groupId`, `expectedRevision` and `currentRevision`, but not the
 * subclass prototype. Branch on `code` through this guard, never `instanceof`
 * or the message text.
 */
export const GROUP_REVISION_CONFLICT = "GROUP_REVISION_CONFLICT" as const;

export interface GroupRevisionConflict {
  code: typeof GROUP_REVISION_CONFLICT;
  groupId: string;
  expectedRevision: number;
  currentRevision: number;
}

export function isGroupRevisionConflict(
  error: unknown,
): error is Error & GroupRevisionConflict {
  if (!(error instanceof Error)) return false;
  const fields = error as Error & Partial<GroupRevisionConflict>;
  return (
    fields.code === GROUP_REVISION_CONFLICT &&
    typeof fields.groupId === "string" &&
    typeof fields.currentRevision === "number"
  );
}
