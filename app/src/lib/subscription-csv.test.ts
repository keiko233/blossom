import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CSV_COLUMNS,
  type SubscriptionCsvRow,
  subscriptionsToCsv,
} from "./subscription-csv";

const row: SubscriptionCsvRow = {
  id: "sub-1",
  userId: "user-1",
  userName: '=Evil, "Name"',
  userEmail: "a@example.com",
  planName: "Pro",
  status: "active",
  startedAt: new Date("2020-01-01T00:00:00.000Z"),
  expiresAt: new Date("2020-02-01T00:00:00.000Z"),
  trafficQuotaBytes: 1000,
  trafficUsedBytes: 250,
  deviceLimit: 3,
  createdAt: new Date("2020-01-01T00:00:00.000Z"),
};

describe("subscriptionsToCsv", () => {
  it("writes the header row", () => {
    const [header] = subscriptionsToCsv([]).split("\r\n");
    expect(header).toBe(SUBSCRIPTION_CSV_COLUMNS.join(","));
  });

  it("escapes user-controlled fields and derives effective status", () => {
    const lines = subscriptionsToCsv([row]).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      [
        "sub-1",
        "user-1",
        '"\'=Evil, ""Name"""',
        "a@example.com",
        "Pro",
        "active",
        // Stored active but long past expiry.
        "expired",
        "2020-01-01T00:00:00.000Z",
        "2020-02-01T00:00:00.000Z",
        "1000",
        "250",
        "25",
        "3",
        "2020-01-01T00:00:00.000Z",
      ].join(","),
    );
  });

  it("leaves usage empty for unlimited quotas", () => {
    const csv = subscriptionsToCsv([
      { ...row, userName: "n", trafficQuotaBytes: 0, trafficUsedBytes: 5 },
    ]);
    const cells = csv.split("\r\n")[1].split(",");
    expect(cells[SUBSCRIPTION_CSV_COLUMNS.indexOf("usage_percent")]).toBe("");
  });
});
