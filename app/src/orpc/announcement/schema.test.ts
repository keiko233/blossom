import { describe, expect, it } from "vitest";

import { createAnnouncementSchema, updateAnnouncementSchema } from "./schema";

const valid = {
  title: "Maintenance window",
  body: "Servers restart at 02:00 UTC.",
  level: "warning",
  audience: "all",
  planIds: [],
  pinned: false,
  published: true,
  startsAt: null,
  endsAt: null,
};

describe("createAnnouncementSchema", () => {
  it("accepts a valid announcement", () => {
    const result = createAnnouncementSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("applies defaults for omitted optional fields", () => {
    const result = createAnnouncementSchema.parse({
      title: "Hello",
      body: "World",
    });
    expect(result).toMatchObject({
      level: "info",
      audience: "all",
      planIds: [],
      pinned: false,
      published: false,
      startsAt: null,
      endsAt: null,
    });
  });

  it("rejects a plan audience with no plans", () => {
    const result = createAnnouncementSchema.safeParse({
      ...valid,
      audience: "plan",
      planIds: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["planIds"]);
    }
  });

  it("accepts a plan audience with at least one plan", () => {
    const result = createAnnouncementSchema.safeParse({
      ...valid,
      audience: "plan",
      planIds: ["plan-a"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an end time that is not after the start time", () => {
    const result = createAnnouncementSchema.safeParse({
      ...valid,
      startsAt: new Date("2026-06-02T00:00:00.000Z"),
      endsAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["endsAt"]);
    }
  });

  it("rejects an empty title and an over-long body", () => {
    expect(
      createAnnouncementSchema.safeParse({ ...valid, title: "   " }).success,
    ).toBe(false);
    expect(
      createAnnouncementSchema.safeParse({ ...valid, body: "x".repeat(5001) })
        .success,
    ).toBe(false);
  });
});

describe("updateAnnouncementSchema", () => {
  it("accepts a partial update with only an id and published flag", () => {
    const result = updateAnnouncementSchema.safeParse({
      id: "a1",
      published: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a partial update that sets a plan audience with no plans", () => {
    const result = updateAnnouncementSchema.safeParse({
      id: "a1",
      audience: "plan",
      planIds: [],
    });
    expect(result.success).toBe(false);
  });
});
