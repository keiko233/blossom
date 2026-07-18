import {
  classifyImportedValidity,
  type ParsedCertificateMaterial,
} from "./certificate-material";

export type ImportedCertificateState =
  | "pending"
  | "active"
  | "expired"
  | "not_yet_valid";

export interface ImportedPolicyVersionSnapshot {
  activeMaterialVersion: number | null;
  pendingMaterialVersion: number | null;
  desiredGeneration: number;
  state: ImportedCertificateState;
}

export interface ImportedReplacementPlan {
  targetVersion: number;
  activeMaterialVersion: number | null;
  pendingMaterialVersion: number | null;
  desiredGeneration: number;
  state: ImportedCertificateState;
  replaceCurrentMetadata: boolean;
  notifyServers: boolean;
  retainedVersions: number[];
}

export function assertImportedCertificateKind(kind: string): void {
  if (kind !== "imported") {
    throw new Error(
      "Only imported certificates can use imported certificate material",
    );
  }
}

export function importedMaterialState(
  material: Pick<ParsedCertificateMaterial, "notBefore" | "notAfter">,
  active: boolean,
  now = new Date(),
): ImportedCertificateState {
  const validity = classifyImportedValidity(material, now);
  if (validity === "future") return "not_yet_valid";
  if (validity === "past") return "expired";
  return active ? "active" : "pending";
}

export function planImportedReplacement(
  policy: ImportedPolicyVersionSnapshot,
  material: Pick<ParsedCertificateMaterial, "notBefore" | "notAfter">,
  now = new Date(),
): ImportedReplacementPlan {
  const current = classifyImportedValidity(material, now) === "current";
  const targetVersion =
    policy.pendingMaterialVersion ??
    (policy.activeMaterialVersion === null
      ? 1
      : policy.activeMaterialVersion + 1);
  return {
    targetVersion,
    activeMaterialVersion: current
      ? targetVersion
      : policy.activeMaterialVersion,
    pendingMaterialVersion: current ? null : targetVersion,
    desiredGeneration: current ? targetVersion : policy.desiredGeneration,
    state:
      current || policy.activeMaterialVersion === null
        ? importedMaterialState(material, current, now)
        : policy.state,
    replaceCurrentMetadata: current || policy.activeMaterialVersion === null,
    notifyServers: current,
    retainedVersions: [
      ...new Set(
        [policy.activeMaterialVersion, targetVersion].filter(
          (version): version is number => version !== null,
        ),
      ),
    ],
  };
}

export function planPendingImportedActivation(
  pendingVersion: number,
  material: Pick<ParsedCertificateMaterial, "notBefore" | "notAfter">,
  now = new Date(),
) {
  return {
    activeMaterialVersion: pendingVersion,
    pendingMaterialVersion: null,
    desiredGeneration: pendingVersion,
    state: importedMaterialState(material, true, now),
    notifyServers: true,
  } as const;
}

export function planPendingImportedDiscard(
  policy: Pick<
    ImportedPolicyVersionSnapshot,
    "activeMaterialVersion" | "state"
  > & {
    notBefore: Date | null;
    notAfter: Date | null;
  },
  now = new Date(),
) {
  if (policy.activeMaterialVersion === null) {
    return {
      state: "pending" as const,
      clearCurrentMetadata: true,
      notifyServers: false,
    };
  }
  return {
    state:
      policy.notBefore && policy.notAfter
        ? importedMaterialState(
            { notBefore: policy.notBefore, notAfter: policy.notAfter },
            true,
            now,
          )
        : policy.state,
    clearCurrentMetadata: false,
    notifyServers: false,
  } as const;
}
