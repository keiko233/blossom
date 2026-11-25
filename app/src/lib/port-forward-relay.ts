import type { ResolvedNode, ServerSummary } from "@/query/subscription-access";

/**
 * Pure subscription-export overlay for an L4 port forward.
 *
 * An enabled `port_forward` on a transit server points at a managed exit
 * `node`. The exit node keeps its protocol, TLS/Reality settings, SNI and
 * subscriber credentials, while the client-facing endpoint becomes the transit
 * server's public address and the forward's listen port. Authentication and
 * metering therefore still happen once, at the exit node.
 */
export interface PortForwardRelayInput {
  id: string;
  runtimeTag: string;
  name: string;
  listenPort: number;
  targetNodeId: string | null;
  enabled?: boolean;
}

/** Identity of the relay that produced a client-facing entrance. */
export interface PortForwardRelay {
  forwardId: string;
  runtimeTag: string;
  targetNodeId: string;
  transitServerId: string;
  transitServerEnabled: boolean;
  exitServerEnabled: boolean;
}

/**
 * Returns `resolvedNode` unchanged unless the forward is enabled and targets
 * exactly this exit node. The caller decides whether the transit server is
 * currently ready; the overlay only rewrites the client-facing endpoint.
 */
export function applyPortForwardOverlay(
  resolvedNode: ResolvedNode,
  forward: PortForwardRelayInput,
  transitServer: ServerSummary,
): ResolvedNode {
  if (forward.enabled === false) {
    return resolvedNode;
  }
  if (
    forward.targetNodeId === null ||
    forward.targetNodeId !== resolvedNode.node.id
  ) {
    return resolvedNode;
  }

  return {
    ...resolvedNode,
    node: {
      ...resolvedNode.node,
      name: forward.name,
      listenPort: forward.listenPort,
    },
    server: transitServer,
    address: transitServer.address,
    portOverride: forward.listenPort,
    nameOverride: forward.name,
    portForward: {
      forwardId: forward.id,
      runtimeTag: forward.runtimeTag,
      targetNodeId: forward.targetNodeId,
      transitServerId: transitServer.id,
      transitServerEnabled: transitServer.enabled !== false,
      exitServerEnabled: resolvedNode.server.enabled !== false,
    },
  };
}
