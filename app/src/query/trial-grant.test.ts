import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "@/lib/settings";

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  getSettings: vi.fn(),
  insertSubscription: vi.fn(),
}));

// `db.select().from().where()` is awaited directly for the plan lookup and has
// `.limit()` for the existing-subscription lookup; each select consumes the
// next queued result.
vi.mock("@/db", () => ({
  db: {
    select: () => {
      const rows = mocks.selectResults.shift() ?? [];
      const afterWhere = Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(rows),
      });
      return { from: () => ({ where: () => afterWhere }) };
    },
  },
}));
vi.mock("@/query/settings-store", () => ({
  getSettings: mocks.getSettings,
}));
vi.mock("@/query/subscription-write", () => ({
  insertSubscription: mocks.insertSubscription,
}));

import { grantSignupTrial } from "./trial-grant";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const PLAN = {
  id: "plan-1",
  durationDays: 30,
  trafficBytes: 1000,
  deviceLimit: 2,
};

function configureTrial(
  trial: Partial<ReturnType<typeof defaultSettings>["trial"]>,
) {
  mocks.getSettings.mockResolvedValue({
    ...defaultSettings(),
    trial: { enabled: true, planId: "plan-1", durationDays: null, ...trial },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.selectResults = [];
  mocks.getSettings.mockReset();
  mocks.insertSubscription.mockReset().mockResolvedValue({ id: "sub" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("grantSignupTrial", () => {
  it("does nothing when trials are off", async () => {
    mocks.getSettings.mockResolvedValue(defaultSettings());
    expect(await grantSignupTrial("u1", "magic-link")).toBe("not_applicable");
    expect(mocks.insertSubscription).not.toHaveBeenCalled();
  });

  it("never trials an admin-created account", async () => {
    configureTrial({});
    expect(await grantSignupTrial("u1", "admin")).toBe("not_applicable");
    expect(mocks.insertSubscription).not.toHaveBeenCalled();
  });

  it("creates the subscription through insertSubscription, keyed by the user", async () => {
    configureTrial({});
    mocks.selectResults = [[PLAN], []];
    expect(await grantSignupTrial("u1", "oauth")).toBe("granted");
    expect(mocks.insertSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.insertSubscription).toHaveBeenCalledWith({
      id: "trial_u1",
      userId: "u1",
      plan: PLAN,
      startedAt: NOW,
      expiresAt: new Date("2026-03-31T00:00:00.000Z"),
    });
  });

  it("honours the duration override", async () => {
    configureTrial({ durationDays: 3 });
    mocks.selectResults = [[PLAN], []];
    await grantSignupTrial("u1", "oauth");
    expect(mocks.insertSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date("2026-03-04T00:00:00.000Z"),
      }),
    );
  });

  it("skips quietly when the trial plan no longer exists", async () => {
    configureTrial({ planId: "deleted" });
    mocks.selectResults = [[]];
    expect(await grantSignupTrial("u1", "oauth")).toBe("plan_missing");
    expect(mocks.insertSubscription).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not grant to a user who already has a subscription", async () => {
    configureTrial({});
    mocks.selectResults = [[PLAN], [{ id: "existing" }]];
    expect(await grantSignupTrial("u1", "oauth")).toBe("already_granted");
    expect(mocks.insertSubscription).not.toHaveBeenCalled();
  });

  it("treats the primary-key collision of a repeated grant as already granted", async () => {
    configureTrial({});
    mocks.selectResults = [[PLAN], []];
    mocks.insertSubscription.mockRejectedValue(
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    expect(await grantSignupTrial("u1", "oauth")).toBe("already_granted");
  });

  it("lets other failures propagate to the caller", async () => {
    configureTrial({});
    mocks.selectResults = [[PLAN], []];
    mocks.insertSubscription.mockRejectedValue(new Error("db down"));
    await expect(grantSignupTrial("u1", "oauth")).rejects.toThrow("db down");
  });
});
