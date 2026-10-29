import { describe, expect, it } from "vitest";

import {
  isAnnouncementVisible,
  sortAnnouncements,
  type VisibilityAnnouncement,
} from "./announcements";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function makeAnnouncement(
  overrides: Partial<VisibilityAnnouncement> = {},
): VisibilityAnnouncement {
  return {
    published: true,
    audience: "all",
    planIds: [],
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

describe("isAnnouncementVisible", () => {
  it("hides unpublished announcements for every audience", () => {
    const ctx = { now: NOW, activePlanIds: ["p1"] };
    expect(
      isAnnouncementVisible(makeAnnouncement({ published: false }), ctx),
    ).toBe(false);
    expect(
      isAnnouncementVisible(
        makeAnnouncement({ published: false, audience: "active" }),
        ctx,
      ),
    ).toBe(false);
  });

  it("shows an 'all' announcement to everyone, subscribed or not", () => {
    const a = makeAnnouncement({ audience: "all" });
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: [] })).toBe(
      true,
    );
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: ["p1"] })).toBe(
      true,
    );
  });

  it("shows an 'active' announcement only with an active subscription", () => {
    const a = makeAnnouncement({ audience: "active" });
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: [] })).toBe(
      false,
    );
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: ["p9"] })).toBe(
      true,
    );
  });

  it("shows a 'plan' announcement only to holders of one of its plans", () => {
    const a = makeAnnouncement({ audience: "plan", planIds: ["p1", "p2"] });
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: ["p3"] })).toBe(
      false,
    );
    expect(
      isAnnouncementVisible(a, { now: NOW, activePlanIds: ["p3", "p2"] }),
    ).toBe(true);
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: [] })).toBe(
      false,
    );
  });

  it("treats startsAt as inclusive", () => {
    const a = makeAnnouncement({ startsAt: NOW });
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: [] })).toBe(
      true,
    );
    expect(
      isAnnouncementVisible(a, {
        now: new Date(NOW.getTime() - 1),
        activePlanIds: [],
      }),
    ).toBe(false);
  });

  it("treats endsAt as exclusive", () => {
    const a = makeAnnouncement({ endsAt: NOW });
    expect(
      isAnnouncementVisible(a, {
        now: new Date(NOW.getTime() - 1),
        activePlanIds: [],
      }),
    ).toBe(true);
    expect(isAnnouncementVisible(a, { now: NOW, activePlanIds: [] })).toBe(
      false,
    );
  });

  it("treats a missing bound as unbounded", () => {
    const future = new Date(NOW.getTime() + HOUR);
    const past = new Date(NOW.getTime() - HOUR);
    const ctx = { now: NOW, activePlanIds: [] };
    expect(
      isAnnouncementVisible(makeAnnouncement({ startsAt: past }), ctx),
    ).toBe(true);
    expect(
      isAnnouncementVisible(makeAnnouncement({ endsAt: future }), ctx),
    ).toBe(true);
    expect(
      isAnnouncementVisible(makeAnnouncement({ startsAt: future }), ctx),
    ).toBe(false);
    expect(isAnnouncementVisible(makeAnnouncement({ endsAt: past }), ctx)).toBe(
      false,
    );
  });
});

describe("sortAnnouncements", () => {
  const base = {
    pinned: false,
    level: "info" as const,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
  };

  it("puts pinned announcements first", () => {
    const sorted = sortAnnouncements([
      { ...base, id: "a", level: "critical" as const },
      { ...base, id: "b", pinned: true, level: "info" as const },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("orders by level within the same pinned state", () => {
    const sorted = sortAnnouncements([
      { ...base, id: "info", level: "info" as const },
      { ...base, id: "critical", level: "critical" as const },
      { ...base, id: "warning", level: "warning" as const },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["critical", "warning", "info"]);
  });

  it("orders newest first within the same pinned state and level", () => {
    const sorted = sortAnnouncements([
      { ...base, id: "old", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { ...base, id: "new", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      { ...base, id: "a", level: "info" as const },
      { ...base, id: "b", level: "critical" as const },
    ];
    sortAnnouncements(input);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
