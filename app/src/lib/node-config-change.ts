import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { managedCertificate, type Node, server } from "@/db/proxy-schema";
import { canonicalize } from "@/orpc/proxy/singbox";

import type { NodeChangePrevRow } from "./publish-gate";

/**
 * Decides whether a node mutation changes the agent-facing config or the
 * client connection parameters, and therefore must be recorded as a publish
 * -gate change.
 *
 * Only these fields feed the compiled sing-box inbound or the Clash proxy
 * connection tuple: protocol, listenPort, settings, certificateId,
 * tlsServerName, serverId, enabled. Display-only fields (name, remark, tags)
 * and the client-side address override change no agent state, so publishing
 * them immediately is safe and skips a pointless agent reload.
 *
 * A disabled node is absent from both payloads, so a change matters only when
 * the node is enabled on at least one side of the transition.
 */
export function isNodeConfigChange(
  before: Node,
  after: Pick<
    Node,
    | "protocol"
    | "listenPort"
    | "settings"
    | "certificateId"
    | "tlsServerName"
    | "serverId"
    | "enabled"
  >,
): boolean {
  if (!before.enabled && !after.enabled) {
    return false;
  }
  return (
    before.protocol !== after.protocol ||
    before.listenPort !== after.listenPort ||
    before.certificateId !== after.certificateId ||
    before.tlsServerName !== after.tlsServerName ||
    before.serverId !== after.serverId ||
    before.enabled !== after.enabled ||
    // Canonical JSON: the stored fragment is re-normalized on write, so key
    // order alone must not register as a change.
    canonicalize(before.settings) !== canonicalize(after.settings)
  );
}

/**
 * Loads the publish-gate snapshot for a node: the row itself plus the server
 * summary and certificate kind the Clash compiler needs to rebuild the exact
 * pre-change proxy entry. `nodeId` may name an about-to-be-deleted row.
 */
export async function snapshotNodeForGate(
  db: Database,
  nodeRow: Node,
): Promise<NodeChangePrevRow> {
  const [serverRow] = await db
    .select({
      id: server.id,
      name: server.name,
      address: server.address,
    })
    .from(server)
    .where(eq(server.id, nodeRow.serverId));
  if (!serverRow) {
    throw new Error("Node has no owning server");
  }
  let certificateKind: NodeChangePrevRow["certificateKind"] = null;
  if (nodeRow.certificateId) {
    const [certRow] = await db
      .select({ kind: managedCertificate.kind })
      .from(managedCertificate)
      .where(eq(managedCertificate.id, nodeRow.certificateId));
    certificateKind = certRow?.kind ?? null;
  }
  return {
    node: nodeRow,
    server: serverRow,
    certificateKind,
  };
}
