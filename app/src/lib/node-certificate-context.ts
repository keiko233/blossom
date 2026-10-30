import {
  type CertificateDeploymentInfo,
  type CertificateDeploymentStatus,
} from "@/lib/node-certificate-binding";

/**
 * Pure explanations for the certificate section of the node editor and the
 * node/server usage list of the certificate page. They only restate what the
 * control plane already knows (the saved node, the per-server binding and the
 * agent's last report); none of them claims that clients can connect.
 */

export type NodeCertificateUsage =
  | "protocol_without_tls"
  | "tls_disabled"
  | "reality"
  | "none_selected"
  | "managed";

/**
 * Which of the node's TLS configurations the editor is in. Reality and
 * non-TLS nodes never use a managed certificate, so they must not be told to
 * pick one; this is the same condition `toPayload` uses to keep or drop the
 * certificate on save.
 */
export function classifyNodeCertificateUsage(input: {
  protocolSupportsTls: boolean;
  tlsEnabled: boolean;
  realityEnabled: boolean;
  certificateId: string;
}): NodeCertificateUsage {
  if (!input.protocolSupportsTls) return "protocol_without_tls";
  if (!input.tlsEnabled) return "tls_disabled";
  if (input.realityEnabled) return "reality";
  return input.certificateId ? "managed" : "none_selected";
}

export type NodeCertificateDeployment =
  | { kind: "none" }
  /** Selected but not saved yet: saving binds it and queues the install. */
  | { kind: "on_save" }
  /** Saved on a node, yet no enabled binding row is reported for the server. */
  | { kind: "unreported" }
  | {
      kind: CertificateDeploymentStatus;
      phase: string | null;
      message: string | null;
      /** Whether the server's agent has reported recently (not client reachability). */
      agentReachable: boolean | undefined;
    };

/**
 * Describes where the certificate currently chosen in the editor stands on the
 * node's server. An unsaved choice (different certificate or server than the
 * stored node) is reported as `on_save` rather than borrowing the status of
 * some other binding.
 */
export function describeNodeCertificateDeployment(input: {
  selectedCertificateId: string;
  selectedServerId: string;
  saved: { certificateId: string | null; serverId: string } | undefined;
  /** The deployment status of the selected certificate on the selected server. */
  binding: CertificateDeploymentInfo | undefined;
  agentReachable: boolean | undefined;
}): NodeCertificateDeployment {
  if (!input.selectedCertificateId) return { kind: "none" };
  const unchanged =
    input.saved !== undefined &&
    input.saved.certificateId === input.selectedCertificateId &&
    input.saved.serverId === input.selectedServerId;
  if (!unchanged) return { kind: "on_save" };
  if (!input.binding) return { kind: "unreported" };
  return {
    kind: input.binding.status,
    phase: input.binding.phase,
    message: input.binding.message,
    agentReachable: input.agentReachable,
  };
}

/**
 * Whether the agent's own deployment report is stale enough that a pending
 * install is waiting on the agent rather than in progress. `undefined` means
 * the server list has not told us.
 */
export function isDeploymentWaitingOnAgent(
  deployment: NodeCertificateDeployment,
): boolean {
  return deployment.kind === "pending" && deployment.agentReachable === false;
}

/** Selectable certificates, plus how many exist but cannot be used yet. */
export function summarizeCertificateChoices<T>(
  certificates: readonly T[],
  isUsable: (certificate: T) => boolean,
): { usable: T[]; unusableCount: number } {
  const usable = certificates.filter(isUsable);
  return { usable, unusableCount: certificates.length - usable.length };
}

export interface CertificateNodeUsage {
  nodeId: string;
  nodeName: string;
  serverId: string;
  serverName: string;
}

/**
 * Nodes that reference a certificate, for the certificate page. A node only
 * stores a certificate while it actually uses it (TLS on, not Reality), so a
 * stored reference is a real use.
 */
export function nodesUsingCertificate<
  N extends {
    id: string;
    name: string;
    serverId: string;
    certificateId: string | null;
    serverSummary: { name: string };
  },
>(certificateId: string, nodes: readonly N[]): CertificateNodeUsage[] {
  return nodes
    .filter((node) => node.certificateId === certificateId)
    .map((node) => ({
      nodeId: node.id,
      nodeName: node.name,
      serverId: node.serverId,
      serverName: node.serverSummary.name,
    }));
}
