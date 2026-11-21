import { describe, expect, it } from "vitest";

import {
  GROUP_REVISION_CONFLICT,
  isGroupRevisionConflict,
} from "./group-revision-conflict";

/** The shape seroval rebuilds on the client: a plain Error, own fields kept. */
function deserializedConflict(): Error {
  return Object.assign(new Error("Group g1 revision conflict"), {
    name: "GroupMembershipConflictError",
    code: GROUP_REVISION_CONFLICT,
    groupId: "g1",
    expectedRevision: 3,
    currentRevision: 4,
  });
}

describe("isGroupRevisionConflict", () => {
  it("matches the deserialized server error by code", () => {
    const error = deserializedConflict();
    expect(isGroupRevisionConflict(error)).toBe(true);
    if (isGroupRevisionConflict(error)) {
      expect(error.currentRevision).toBe(4);
    }
  });

  it("rejects other errors and non-errors", () => {
    expect(isGroupRevisionConflict(new Error("Not found"))).toBe(false);
    expect(
      isGroupRevisionConflict(
        Object.assign(new Error("x"), { code: "OTHER", groupId: "g1" }),
      ),
    ).toBe(false);
    expect(
      isGroupRevisionConflict({
        code: GROUP_REVISION_CONFLICT,
        groupId: "g1",
        currentRevision: 1,
      }),
    ).toBe(false);
  });
});
