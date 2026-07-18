import "reflect-metadata";
import { describe, expect, it } from "vitest";

import {
  assertImportedCertificateKind,
  planImportedReplacement,
  planPendingImportedActivation,
  planPendingImportedDiscard,
} from "./certificate-import-lifecycle";

const now = new Date("2026-01-15T00:00:00Z");
const current = {
  notBefore: new Date("2026-01-01T00:00:00Z"),
  notAfter: new Date("2026-02-01T00:00:00Z"),
};
const future = {
  notBefore: new Date("2026-02-01T00:00:00Z"),
  notAfter: new Date("2026-03-01T00:00:00Z"),
};
const past = {
  notBefore: new Date("2025-01-01T00:00:00Z"),
  notAfter: new Date("2025-02-01T00:00:00Z"),
};

describe("imported certificate lifecycle planning", () => {
  it.each(["acme", "self_signed"])(
    "rejects external replacement for %s certificates",
    (kind) => {
      expect(() => assertImportedCertificateKind(kind)).toThrow(
        "Only imported certificates",
      );
    },
  );

  it("activates a current in-place replacement and preserves the prior version", () => {
    expect(
      planImportedReplacement(
        {
          activeMaterialVersion: 4,
          pendingMaterialVersion: null,
          desiredGeneration: 4,
          state: "active",
        },
        current,
        now,
      ),
    ).toEqual({
      targetVersion: 5,
      activeMaterialVersion: 5,
      pendingMaterialVersion: null,
      desiredGeneration: 5,
      state: "active",
      replaceCurrentMetadata: true,
      notifyServers: true,
      retainedVersions: [4, 5],
    });
  });

  it.each([future, past])(
    "stages invalid material without changing the active generation",
    (material) => {
      const plan = planImportedReplacement(
        {
          activeMaterialVersion: 4,
          pendingMaterialVersion: null,
          desiredGeneration: 4,
          state: "active",
        },
        material,
        now,
      );
      expect(plan).toMatchObject({
        activeMaterialVersion: 4,
        pendingMaterialVersion: 5,
        desiredGeneration: 4,
        state: "active",
        replaceCurrentMetadata: false,
        notifyServers: false,
      });
    },
  );

  it.each([
    [future, "not_yet_valid"],
    [past, "expired"],
  ] as const)(
    "exposes pending-only material validity as %s",
    (material, state) => {
      expect(
        planImportedReplacement(
          {
            activeMaterialVersion: null,
            pendingMaterialVersion: null,
            desiredGeneration: 1,
            state: "pending",
          },
          material,
          now,
        ).state,
      ).toBe(state);
    },
  );

  it("reuses and replaces an existing pending version", () => {
    const plan = planImportedReplacement(
      {
        activeMaterialVersion: 4,
        pendingMaterialVersion: 5,
        desiredGeneration: 4,
        state: "active",
      },
      future,
      now,
    );
    expect(plan.targetVersion).toBe(5);
    expect(plan.retainedVersions).toEqual([4, 5]);
  });

  it.each([
    [current, "active"],
    [future, "not_yet_valid"],
    [past, "expired"],
  ] as const)(
    "force-activates pending material while retaining validity state",
    (material, state) => {
      expect(planPendingImportedActivation(5, material, now)).toEqual({
        activeMaterialVersion: 5,
        pendingMaterialVersion: null,
        desiredGeneration: 5,
        state,
        notifyServers: true,
      });
    },
  );

  it("discards pending material without changing active metadata or bindings", () => {
    expect(
      planPendingImportedDiscard(
        {
          activeMaterialVersion: 4,
          state: "active",
          notBefore: current.notBefore,
          notAfter: current.notAfter,
        },
        now,
      ),
    ).toEqual({
      state: "active",
      clearCurrentMetadata: false,
      notifyServers: false,
    });
  });

  it("clears pending-only metadata when pending material is discarded", () => {
    expect(
      planPendingImportedDiscard({
        activeMaterialVersion: null,
        state: "not_yet_valid",
        notBefore: future.notBefore,
        notAfter: future.notAfter,
      }),
    ).toEqual({
      state: "pending",
      clearCurrentMetadata: true,
      notifyServers: false,
    });
  });
});
