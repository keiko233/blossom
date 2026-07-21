export interface CertificateActionContext {
  certificate: {
    id: string;
    domains: string[];
    activeMaterialVersion: number | null;
  };
  binding: {
    enabled: boolean;
    desiredGeneration: number;
    appliedGeneration: number | null;
  };
  material?: {
    certificatePem: string;
    privateKeyPem: string;
    notBefore: string;
    notAfter: string;
    fingerprintSha256: string;
  };
}

export function certificateActionFor(
  item: CertificateActionContext,
  serverId: string,
): ({ id: string; type: string } & Record<string, unknown>) | null {
  const { certificate, binding, material } = item;
  const activeGeneration = certificate.activeMaterialVersion;
  if (!binding.enabled) {
    const generation = binding.appliedGeneration ?? binding.desiredGeneration;
    return {
      id: `certificate:${certificate.id}:${serverId}:${generation}:remove`,
      certificateId: certificate.id,
      generation,
      domains: certificate.domains,
      type: "certificate.remove",
    };
  }
  if (material && activeGeneration !== null) {
    return {
      id: `certificate:${certificate.id}:${serverId}:${activeGeneration}:install`,
      certificateId: certificate.id,
      generation: activeGeneration,
      domains: certificate.domains,
      type: "certificate.install",
      // The control plane cannot know whether the agent's local state volume
      // still contains material that was previously acknowledged. Agents use
      // the action as desired state and repair missing/mismatched files
      // idempotently; this flag only controls whether an unchanged install
      // needs to be acknowledged again.
      reportRequired: binding.appliedGeneration !== activeGeneration,
      material,
    };
  }

  return null;
}
