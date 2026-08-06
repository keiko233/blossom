import { describe, expect, it } from "vitest";

import {
  BINDING_DISABLE_WRITE,
  BINDING_GENERATION_RESET_WRITE,
  bindingUpsertWrite,
  describeCertificateDeployment,
  isNewlyActivatedBinding,
  planBindingUpsert,
  shouldDisableBinding,
} from "./node-certificate-binding";

describe("planBindingUpsert", () => {
  it("inserts when no binding row exists", () => {
    expect(planBindingUpsert(null, 3)).toEqual({
      kind: "insert",
      desiredGeneration: 3,
    });
  });

  it("re-enables a previously disabled row and resets to the current generation", () => {
    expect(
      planBindingUpsert({ enabled: false, desiredGeneration: 1 }, 5),
    ).toEqual({ kind: "re-enable", desiredGeneration: 5 });
  });

  it("advances an enabled row whose generation is stale", () => {
    expect(
      planBindingUpsert({ enabled: true, desiredGeneration: 2 }, 5),
    ).toEqual({ kind: "advance", desiredGeneration: 5 });
  });

  it("is a noop for an enabled row already on the certificate generation", () => {
    expect(
      planBindingUpsert({ enabled: true, desiredGeneration: 5 }, 5),
    ).toEqual({ kind: "noop" });
  });
});

describe("bindingUpsertWrite", () => {
  it("fully resets acknowledgement state on insert", () => {
    expect(
      bindingUpsertWrite({ kind: "insert", desiredGeneration: 4 }),
    ).toMatchObject({
      enabled: true,
      desiredGeneration: 4,
      state: "pending",
      appliedGeneration: null,
      installedGeneration: null,
      installedFingerprintSha256: null,
      installedAt: null,
      inUseAt: null,
      lastErrorPhase: null,
      lastError: null,
    });
  });

  it("fully resets acknowledgement state on re-enable", () => {
    const write = bindingUpsertWrite({
      kind: "re-enable",
      desiredGeneration: 7,
    });
    expect(write).toMatchObject({
      enabled: true,
      state: "pending",
      installedGeneration: null,
    });
  });

  it("keeps installed metadata when advancing generations", () => {
    const write = bindingUpsertWrite({
      kind: "advance",
      desiredGeneration: 9,
    });
    expect(write).toMatchObject({
      enabled: true,
      desiredGeneration: 9,
      state: "pending",
      appliedGeneration: null,
      inUseAt: null,
    });
    expect(write.installedGeneration).toBeUndefined();
    expect(write.installedFingerprintSha256).toBeUndefined();
    expect(write.installedAt).toBeUndefined();
  });
});

describe("isNewlyActivatedBinding", () => {
  it("treats insert and re-enable as newly activated", () => {
    expect(
      isNewlyActivatedBinding({ kind: "insert", desiredGeneration: 1 }),
    ).toBe(true);
    expect(
      isNewlyActivatedBinding({ kind: "re-enable", desiredGeneration: 1 }),
    ).toBe(true);
  });

  it("treats advance and noop as not newly activated", () => {
    expect(
      isNewlyActivatedBinding({ kind: "advance", desiredGeneration: 1 }),
    ).toBe(false);
    expect(isNewlyActivatedBinding({ kind: "noop" })).toBe(false);
    expect(isNewlyActivatedBinding(null)).toBe(false);
  });
});

describe("shouldDisableBinding", () => {
  it("disables an enabled binding only when no other node uses the certificate", () => {
    expect(shouldDisableBinding({ enabled: true }, 0)).toBe(true);
    expect(shouldDisableBinding({ enabled: true }, 1)).toBe(false);
    expect(shouldDisableBinding({ enabled: false }, 0)).toBe(false);
    expect(shouldDisableBinding(null, 0)).toBe(false);
  });
});

describe("BINDING_DISABLE_WRITE", () => {
  it("disables and resets applied/error state while keeping installed metadata", () => {
    expect(BINDING_DISABLE_WRITE).toMatchObject({
      enabled: false,
      state: "pending",
      appliedGeneration: null,
      inUseAt: null,
      lastErrorPhase: null,
      lastError: null,
    });
    expect(BINDING_DISABLE_WRITE.installedGeneration).toBeUndefined();
  });
});

describe("BINDING_GENERATION_RESET_WRITE", () => {
  it("clears stale applied/error state without claiming installed material changed", () => {
    expect(BINDING_GENERATION_RESET_WRITE).toMatchObject({
      state: "pending",
      appliedGeneration: null,
      inUseAt: null,
      lastErrorPhase: null,
      lastError: null,
    });
    expect(BINDING_GENERATION_RESET_WRITE.installedGeneration).toBeUndefined();
    expect(
      BINDING_GENERATION_RESET_WRITE.installedFingerprintSha256,
    ).toBeUndefined();
  });
});

describe("describeCertificateDeployment", () => {
  const base = {
    enabled: true,
    state: "pending",
    desiredGeneration: 3,
    installedGeneration: null,
    installedFingerprintSha256: null,
    appliedGeneration: null,
    inUseAt: null,
    lastErrorPhase: null,
    lastError: null,
  };

  it("reports pending when nothing is installed yet", () => {
    expect(describeCertificateDeployment(base)).toEqual({
      status: "pending",
      phase: null,
      message: null,
    });
  });

  it("reports installed when material matches the desired generation but is not in use", () => {
    expect(
      describeCertificateDeployment({
        ...base,
        installedGeneration: 3,
        installedFingerprintSha256: "fp",
      }),
    ).toEqual({ status: "installed", phase: null, message: null });
  });

  it("reports in_use only for an accepted, serving deployment", () => {
    expect(
      describeCertificateDeployment({
        ...base,
        state: "active",
        installedGeneration: 3,
        installedFingerprintSha256: "fp",
        appliedGeneration: 3,
        inUseAt: new Date("2026-08-06T00:00:00.000Z"),
      }),
    ).toEqual({ status: "in_use", phase: null, message: null });
  });

  it("does not report in_use without a current installed generation and explicit in-use acknowledgement", () => {
    expect(
      describeCertificateDeployment({
        ...base,
        state: "active",
        installedGeneration: 2,
        installedFingerprintSha256: "old-fp",
        appliedGeneration: 3,
        inUseAt: new Date("2026-08-06T00:00:00.000Z"),
      }),
    ).toEqual({ status: "pending", phase: null, message: null });

    expect(
      describeCertificateDeployment({
        ...base,
        state: "active",
        installedGeneration: 3,
        installedFingerprintSha256: "fp",
        appliedGeneration: 3,
      }),
    ).toEqual({ status: "installed", phase: null, message: null });
  });

  it("does not call a certificate active merely because it was issued", () => {
    // Issued certificate, but the binding has no deployment acknowledgement yet.
    expect(describeCertificateDeployment({ ...base, state: "active" })).toEqual(
      {
        status: "pending",
        phase: null,
        message: null,
      },
    );
  });

  it("reports error with phase and message when the agent reports one", () => {
    expect(
      describeCertificateDeployment({
        ...base,
        state: "error",
        lastErrorPhase: "install",
        lastError: "material write failed",
      }),
    ).toEqual({
      status: "error",
      phase: "install",
      message: "material write failed",
    });
  });

  it("treats a stale installed generation as still pending install", () => {
    expect(
      describeCertificateDeployment({
        ...base,
        installedGeneration: 2,
        installedFingerprintSha256: "old-fp",
      }),
    ).toEqual({ status: "pending", phase: null, message: null });
  });

  it("reports pending for a disabled (cleanup) binding", () => {
    expect(describeCertificateDeployment({ ...base, enabled: false })).toEqual({
      status: "pending",
      phase: null,
      message: null,
    });
  });
});
