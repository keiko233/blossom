import { doesReportProve } from "@blossom/domain/managed-rollout";
import { describe, expect, it } from "vitest";

import { doesAppliedSnapshotProveStage } from "@/orpc/proxy/singbox";

const FP = `sha256:${"c".repeat(64)}`;
const OTHER = `sha256:${"d".repeat(64)}`;

describe("rollout proof parity with the Task 07 compiler", () => {
  it("agrees with doesAppliedSnapshotProveStage for managed targets", () => {
    const cases = [
      { seq: 9, fingerprint: FP },
      { seq: 10, fingerprint: FP },
      { seq: 11, fingerprint: FP },
      { seq: 11, fingerprint: OTHER },
      { seq: 11, fingerprint: null },
    ];
    const target = { minRevisionSeq: 10, managedFingerprint: FP };
    for (const { seq, fingerprint } of cases) {
      const applied = {
        desiredRevisionSeq: seq,
        managedFingerprint: fingerprint,
      };
      expect(doesReportProve(target, applied)).toBe(
        doesAppliedSnapshotProveStage(target, applied),
      );
    }
  });
});
