import { createPlanSchema } from "@blossom/contracts/plan";
import { createUserSchema } from "@blossom/contracts/user";
import { describe, expect, it } from "vitest";

describe("workspace contracts", () => {
  it("rejects an invalid plan before it reaches the server", () => {
    const plan = {
      name: "Basic",
      priceCents: 100,
      durationDays: 30,
      trafficBytes: 1024,
    };
    expect(createPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      createPlanSchema.safeParse({ ...plan, priceCents: -1 }).success,
    ).toBe(false);
  });

  it("rejects an invalid user email", () => {
    expect(
      createUserSchema.safeParse({ name: "A", email: "a@example.com" }).success,
    ).toBe(true);
    expect(
      createUserSchema.safeParse({ name: "A", email: "invalid" }).success,
    ).toBe(false);
  });
});
