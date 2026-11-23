import { call, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashAgentToken } from "@/lib/agent-token";

const mocks = vi.hoisted(() => ({
  recordAgentTraffic: vi.fn(),
  listServerNodeIds: vi.fn(),
  invalidateDesiredConfigRevisionsAfterCommit: vi.fn(async () => {}),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/query/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/query/agent")>()),
  findAgentServerByTokenHash: vi.fn(async (hash: string) =>
    hash === hashAgentToken("agt_test") ? { id: "srv1", enabled: true } : null,
  ),
  listServerNodeIds: mocks.listServerNodeIds,
  recordAgentTraffic: mocks.recordAgentTraffic,
  invalidateDesiredConfigRevisionsAfterCommit:
    mocks.invalidateDesiredConfigRevisionsAfterCommit,
}));
vi.mock("@/query/certificate-agent", () => ({}));
vi.mock("@/query/rule-access", () => ({}));
vi.mock("@/query/subscription-access", () => ({}));

import { TrafficReportConflictError } from "@/query/agent";

import { reportAgentTraffic } from "./agent";
import { trafficReportSchema } from "./schema";
import { encodeTrafficUser } from "./traffic-user-codec";

const context = { headers: { authorization: "Bearer agt_test" } };
const report = (input: unknown) =>
  call(reportAgentTraffic, input as never, { context });

beforeEach(() => {
  mocks.recordAgentTraffic.mockReset();
  mocks.listServerNodeIds.mockReset();
  mocks.invalidateDesiredConfigRevisionsAfterCommit.mockReset();
  mocks.listServerNodeIds.mockResolvedValue(["n1", "n2"]);
  mocks.recordAgentTraffic.mockResolvedValue({
    accepted: 1,
    dropped: 0,
    duplicate: false,
    quotaExhausted: false,
  });
});

describe("agent traffic report ingestion", () => {
  it("forwards a report id with a content hash and echoes it back", async () => {
    const result = await report({
      reportId: "rpt-0000001",
      windowStartedAt: "2026-10-30T00:00:00.000Z",
      windowEndedAt: "2026-10-30T00:01:00.000Z",
      entries: [
        {
          subscriptionId: encodeTrafficUser("n1", "sub-a"),
          uplinkBytes: 10,
          downlinkBytes: 5,
        },
      ],
    });

    expect(result).toEqual({
      accepted: 1,
      dropped: 0,
      reportId: "rpt-0000001",
      duplicate: false,
    });
    const arg = mocks.recordAgentTraffic.mock.calls[0]![0];
    expect(arg).toMatchObject({
      serverId: "srv1",
      reportId: "rpt-0000001",
      windowStartedAt: new Date("2026-10-30T00:00:00.000Z"),
      entries: [
        {
          subscriptionId: "sub-a",
          nodeId: "n1",
          uplinkBytes: 10,
          downlinkBytes: 5,
        },
      ],
    });
    expect(arg.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a replay as duplicate with the original counts", async () => {
    mocks.recordAgentTraffic.mockResolvedValue({
      accepted: 3,
      dropped: 1,
      duplicate: true,
    });

    await expect(
      report({
        reportId: "rpt-0000002",
        entries: [{ subscriptionId: "s", uplinkBytes: 1, downlinkBytes: 0 }],
      }),
    ).resolves.toEqual({
      accepted: 3,
      dropped: 1,
      reportId: "rpt-0000002",
      duplicate: true,
    });
  });

  it("answers CONFLICT when the id was reused with different content", async () => {
    mocks.recordAgentTraffic.mockRejectedValue(
      new TrafficReportConflictError(),
    );

    const error = await report({
      reportId: "rpt-0000003",
      entries: [{ subscriptionId: "s", uplinkBytes: 9, downlinkBytes: 0 }],
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe("CONFLICT");
  });

  it("invalidates the desired configuration when a report exhausts a quota", async () => {
    mocks.recordAgentTraffic.mockResolvedValue({
      accepted: 1,
      dropped: 0,
      duplicate: false,
      quotaExhausted: true,
    });

    await report({
      reportId: "rpt-0000006",
      entries: [
        {
          subscriptionId: encodeTrafficUser("n1", "sub-a"),
          uplinkBytes: 1,
          downlinkBytes: 0,
        },
      ],
    });

    expect(mocks.recordAgentTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv1" }),
    );
    expect(
      mocks.invalidateDesiredConfigRevisionsAfterCommit,
    ).toHaveBeenCalledWith(["srv1"], undefined);
  });

  it("leaves the desired revision alone when no quota was crossed", async () => {
    await report({
      reportId: "rpt-0000007",
      entries: [
        {
          subscriptionId: encodeTrafficUser("n1", "sub-a"),
          uplinkBytes: 1,
          downlinkBytes: 0,
        },
      ],
    });

    expect(
      mocks.invalidateDesiredConfigRevisionsAfterCommit,
    ).not.toHaveBeenCalled();
  });

  it("keeps legacy agents working: no id, no hash, no echo", async () => {
    mocks.listServerNodeIds.mockResolvedValue(["only-node"]);

    const result = await report({
      entries: [
        { subscriptionId: "bare-sub", uplinkBytes: 4, downlinkBytes: 0 },
      ],
    });

    expect(result).toEqual({ accepted: 1, dropped: 0 });
    const arg = mocks.recordAgentTraffic.mock.calls[0]![0];
    expect(arg.reportId).toBeUndefined();
    expect(arg.contentHash).toBeUndefined();
    expect(arg.entries).toEqual([
      {
        subscriptionId: "bare-sub",
        nodeId: "only-node",
        uplinkBytes: 4,
        downlinkBytes: 0,
      },
    ]);
  });

  it("drops node attribution for a moved node but still credits the subscription", async () => {
    await report({
      reportId: "rpt-0000004",
      entries: [
        {
          subscriptionId: encodeTrafficUser("moved-away", "sub-a"),
          uplinkBytes: 1,
          downlinkBytes: 1,
        },
      ],
    });

    expect(mocks.recordAgentTraffic.mock.calls[0]![0].entries).toEqual([
      {
        subscriptionId: "sub-a",
        nodeId: null,
        uplinkBytes: 1,
        downlinkBytes: 1,
      },
    ]);
  });

  it("records an all-zero report id so it cannot be reused with other content", async () => {
    mocks.recordAgentTraffic.mockResolvedValue({
      accepted: 0,
      dropped: 0,
      duplicate: false,
    });
    const result = await report({
      reportId: "rpt-0000005",
      entries: [{ subscriptionId: "s", uplinkBytes: 0, downlinkBytes: 0 }],
    });

    expect(result).toMatchObject({ accepted: 0, dropped: 0 });
    expect(mocks.recordAgentTraffic).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: "rpt-0000005",
        contentHash: expect.any(String),
        entries: [],
      }),
    );
  });

  it("skips database writes for a legacy all-zero report", async () => {
    await expect(
      report({
        entries: [{ subscriptionId: "s", uplinkBytes: 0, downlinkBytes: 0 }],
      }),
    ).resolves.toEqual({ accepted: 0, dropped: 0 });
    expect(mocks.recordAgentTraffic).not.toHaveBeenCalled();
  });

  it("rejects requests without a valid agent token", async () => {
    const error = await call(reportAgentTraffic, { entries: [] } as never, {
      context: { headers: { authorization: "Bearer nope" } },
    }).catch((e) => e);
    expect(error.code).toBe("UNAUTHORIZED");
  });
});

describe("trafficReportSchema", () => {
  const base = { entries: [] };

  it("accepts the legacy body without a report id", () => {
    expect(trafficReportSchema.safeParse(base).success).toBe(true);
  });

  it.each(["short", "has space!", "x".repeat(129), ""])(
    "rejects report id %j",
    (reportId) => {
      expect(trafficReportSchema.safeParse({ ...base, reportId }).success).toBe(
        false,
      );
    },
  );
});
