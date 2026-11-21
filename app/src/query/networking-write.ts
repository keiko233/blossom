import {
  MANAGED_TOPOLOGY_ID,
  directProfileIpFamilyDialFields,
  managedRuntimeTag,
} from "@blossom/domain/managed-networking";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Database } from "@/db";
import { db } from "@/db";
import {
  listenerClaim,
  managedConfigVersion,
  managedOutbound,
  managedRolloutClaim,
  managedRuleSetAsset,
  managedTopology,
  peerInbound,
  peerLink,
  peerLinkCredential,
} from "@/db/managed-network-schema";
import { managedCertificate, server } from "@/db/proxy-schema";
import { encryptManagedPeerCredential } from "@/lib/managed-credential-crypto";
import type {
  CreatePeerLinkInput,
  ImportRuleSetAssetInput,
  SaveManagedOutboundInput,
  SavePeerInboundInput,
} from "@/lib/networking-schema";
import type { JsonValue } from "@/orpc/proxy/schema";

/**
 * Durable draft writers for the Networking workspace (Task 09). They keep the
 * singleton topology generation compare-and-swap in the same statement as the
 * graph change, so neon-http cannot leave a half-applied draft. Rollout
 * admission, stage issuance and agent notification remain in the Task 06/08
 * writers and are not duplicated here.
 *
 * Managed activation stays off by default. These writers create draft
 * resources but never a rollout, never a stage pointer and never a peer
 * listener claim.
 */

export type NetworkingWriteResult<T> =
  | ({ ok: true; generation: number } & T)
  | { ok: false; reason: string; message?: string };

export const NETWORKING_WRITE_REASONS = [
  "activation_disabled",
  "asset_too_large",
  "certificate_not_found",
  "credential_key_unavailable",
  "duplicate",
  "duplicate_rule_set",
  "not_found",
  "invalid_asset",
  "invalid_link",
  "peer_port_conflict",
  "referenced",
  "stale_topology",
  "topology_conflict",
  "unsupported",
] as const;
export type NetworkingWriteReason = (typeof NETWORKING_WRITE_REASONS)[number];

function jsonParam(value: unknown): SQL {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

async function executeRows<T extends Record<string, unknown>>(
  database: Database,
  statement: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(statement, "objects");
  if (Array.isArray(result)) return result;
  const wrapped = result as unknown as { rows?: T[] };
  return wrapped.rows ?? [];
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function currentGenerationCte(expected: number): SQL {
  return sql`topology_cas AS (
    UPDATE ${managedTopology}
    SET generation = generation + 1,
        updated_at = now()
    WHERE id = ${MANAGED_TOPOLOGY_ID}
      AND generation = ${expected}
    RETURNING generation
  )`;
}

async function generationNow(database: Database): Promise<number> {
  const [row] = await database
    .select({ generation: managedTopology.generation })
    .from(managedTopology)
    .where(eq(managedTopology.id, MANAGED_TOPOLOGY_ID));
  return row?.generation ?? 0;
}

async function conflictReason(database: Database): Promise<{
  ok: false;
  reason: NetworkingWriteReason;
  message: string;
}> {
  return {
    ok: false,
    reason: "topology_conflict",
    message: `A newer topology generation (${await generationNow(database)}) replaced this draft`,
  };
}

async function certificateAvailable(
  database: Database,
  certificateId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: managedCertificate.id })
    .from(managedCertificate)
    .where(eq(managedCertificate.id, certificateId));
  return Boolean(row);
}

async function configVersionReferencesAny(
  database: Database,
  fragments: readonly Record<string, unknown>[],
): Promise<boolean> {
  if (fragments.length === 0) return false;
  const [row] = await database
    .select({ id: managedConfigVersion.id })
    .from(managedConfigVersion)
    .where(
      sql`${sql.join(
        fragments.map(
          (fragment) =>
            sql`${managedConfigVersion.intent} @> ${jsonParam(fragment)}`,
        ),
        sql` OR `,
      )}`,
    )
    .limit(1);
  return Boolean(row);
}

// --- Peer inbounds ----------------------------------------------------------

export async function savePeerInboundDraft(
  input: SavePeerInboundInput,
  database: Database = db,
): Promise<NetworkingWriteResult<{ inboundId: string; runtimeTag: string }>> {
  if (!(await certificateAvailable(database, input.certificateId))) {
    return {
      ok: false,
      reason: "certificate_not_found",
      message: "The selected certificate no longer exists",
    };
  }

  if (input.id) {
    const [existing] = await database
      .select()
      .from(peerInbound)
      .where(eq(peerInbound.id, input.id));
    if (!existing) {
      return {
        ok: false,
        reason: "not_found",
        message: "Peer inbound not found",
      };
    }
    const [referencing] = await database
      .select({ id: peerLink.id })
      .from(peerLink)
      .where(eq(peerLink.destinationInboundId, input.id))
      .limit(1);
    const structural =
      existing.serverId !== input.serverId ||
      existing.protocol !== input.protocol ||
      existing.listenAddress !== input.listenAddress ||
      existing.listenPort !== input.listenPort ||
      existing.advertisedAddress !== input.advertisedAddress ||
      existing.advertisedPort !== input.advertisedPort ||
      existing.tlsServerName !== input.tlsServerName ||
      existing.certificateId !== input.certificateId;
    if (referencing && structural) {
      return {
        ok: false,
        reason: "referenced",
        message:
          "A link uses this peer inbound. Change the display name only, or remove the link through its own draft first.",
      };
    }
    const rows = await executeRows(
      database,
      sql`
        WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
        guard AS (
          SELECT 1 FROM ${peerInbound}
          WHERE ${peerInbound.id} = ${input.id}::text
            AND (
              ${structural ? sql`FALSE` : sql`TRUE`}
              OR NOT EXISTS (
                SELECT 1 FROM ${peerLink}
                WHERE ${peerLink.destinationInboundId} = ${input.id}::text
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${peerInbound} p2
              WHERE p2.server_id = ${input.serverId}::text
                AND p2.listen_port = ${input.listenPort}::integer
                AND p2.id <> ${input.id}::text
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${server} s
              JOIN ${sql.identifier("node")} n ON n.server_id = s.id
              WHERE s.id = ${input.serverId}::text
                AND n.listen_port = ${input.listenPort}::integer
            )
        ),
        updated AS (
          UPDATE ${peerInbound}
          SET name = ${input.name},
              server_id = ${input.serverId},
              protocol = ${input.protocol},
              listen_address = ${input.listenAddress},
              listen_port = ${input.listenPort},
              advertised_address = ${input.advertisedAddress},
              advertised_port = ${input.advertisedPort},
              tls_server_name = ${input.tlsServerName},
              certificate_id = ${input.certificateId},
              revision = revision + 1,
              updated_at = now()
          WHERE id = ${input.id}::text
            AND EXISTS (SELECT 1 FROM guard)
          RETURNING *
        )
        SELECT updated.id, updated.runtime_tag, topology_cas.generation
        FROM updated CROSS JOIN topology_cas
      `,
    );
    if (rows[0]) {
      return {
        ok: true,
        generation: numeric(rows[0].generation),
        inboundId: String(rows[0].id),
        runtimeTag: String(rows[0].runtime_tag),
      };
    }
    const [conflict] = await database
      .select({ id: peerInbound.id })
      .from(peerInbound)
      .where(
        and(
          eq(peerInbound.serverId, input.serverId),
          eq(peerInbound.listenPort, input.listenPort),
        ),
      );
    if (conflict && conflict.id !== input.id) {
      return {
        ok: false,
        reason: "peer_port_conflict",
        message: `Port ${input.listenPort} is already used by another peer listener`,
      };
    }
    const [nodeConflict] = await executeRows<{ id: string }>(
      database,
      sql`
        SELECT id FROM ${sql.identifier("node")}
        WHERE server_id = ${input.serverId}::text
          AND listen_port = ${input.listenPort}::integer
        LIMIT 1
      `,
    );
    if (nodeConflict) {
      return {
        ok: false,
        reason: "peer_port_conflict",
        message: `Port ${input.listenPort} is already used by a subscriber inbound`,
      };
    }
    return conflictReason(database);
  }

  const id = randomUUID();
  const runtimeTag = managedRuntimeTag("peer_inbound", id);
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
      inserted AS (
        INSERT INTO ${peerInbound} (
          id, server_id, name, runtime_tag, protocol,
          listen_address, listen_port,
          advertised_address, advertised_port,
          tls_server_name, certificate_id
        )
        SELECT ${id}::text,
               ${input.serverId}::text,
               ${input.name}::text,
               ${runtimeTag}::text,
               ${input.protocol}::text,
               ${input.listenAddress}::text,
               ${input.listenPort}::integer,
               ${input.advertisedAddress}::text,
               ${input.advertisedPort}::integer,
               ${input.tlsServerName}::text,
               ${input.certificateId}::text
        FROM topology_cas
        WHERE NOT EXISTS (
          SELECT 1 FROM ${peerInbound}
          WHERE ${peerInbound.serverId} = ${input.serverId}::text
            AND ${peerInbound.listenPort} = ${input.listenPort}::integer
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${sql.identifier("node")}
          WHERE server_id = ${input.serverId}::text
            AND listen_port = ${input.listenPort}::integer
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${sql.identifier("listener_claim")}
          WHERE server_id = ${input.serverId}::text
            AND port = ${input.listenPort}::integer
        )
        RETURNING *
      )
      SELECT inserted.id, inserted.runtime_tag, topology_cas.generation
      FROM inserted CROSS JOIN topology_cas
    `,
  );
  if (rows[0]) {
    return {
      ok: true,
      generation: numeric(rows[0].generation),
      inboundId: String(rows[0].id),
      runtimeTag: String(rows[0].runtime_tag),
    };
  }
  const [conflict] = await database
    .select({ id: peerInbound.id })
    .from(peerInbound)
    .where(
      and(
        eq(peerInbound.serverId, input.serverId),
        eq(peerInbound.listenPort, input.listenPort),
      ),
    );
  if (conflict) {
    return {
      ok: false,
      reason: "peer_port_conflict",
      message: `Port ${input.listenPort} is already used by another peer listener`,
    };
  }
  return conflictReason(database);
}

export async function deletePeerInboundDraft(
  id: string,
  expectedGeneration: number,
  database: Database = db,
): Promise<NetworkingDeleteResult> {
  const [existing] = await database
    .select()
    .from(peerInbound)
    .where(eq(peerInbound.id, id));
  if (!existing) {
    return {
      ok: false,
      reason: "not_found",
      message: "Peer inbound not found",
    };
  }
  const [link] = await database
    .select({ id: peerLink.id })
    .from(peerLink)
    .where(eq(peerLink.destinationInboundId, id))
    .limit(1);
  if (link) {
    return {
      ok: false,
      reason: "referenced",
      message: "A link still targets this peer inbound",
    };
  }
  if (
    await configVersionReferencesAny(database, [
      { peerInbounds: [{ inboundId: id }] },
    ])
  ) {
    return {
      ok: false,
      reason: "referenced",
      message: "A saved routing draft still references this peer inbound",
    };
  }
  const [claim] = await database
    .select({ port: listenerClaim.port })
    .from(listenerClaim)
    .where(
      and(
        eq(listenerClaim.ownerKind, "peer_inbound"),
        eq(listenerClaim.ownerId, id),
      ),
    )
    .limit(1);
  if (claim) {
    return {
      ok: false,
      reason: "referenced",
      message: "The listener claim is still held; complete its teardown stage",
    };
  }
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(expectedGeneration)},
      removed AS (
        DELETE FROM ${peerInbound}
        WHERE id = ${id}::text
          AND EXISTS (SELECT 1 FROM topology_cas)
          AND NOT EXISTS (
            SELECT 1 FROM ${peerLink}
            WHERE destination_inbound_id = ${id}::text
          )
        RETURNING id
      )
      SELECT removed.id, topology_cas.generation
      FROM removed CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) return conflictReason(database);
  return { ok: true, generation: numeric(rows[0].generation) };
}

type NetworkingDeleteResult =
  | { ok: true; generation: number }
  | { ok: false; reason: string; message?: string };

// --- Links and peer outbounds ----------------------------------------------

function peerSecret(protocol: "trojan" | "vless"): string {
  return protocol === "vless"
    ? randomUUID()
    : randomBytes(24).toString("base64url");
}

export async function createPeerLinkDraft(
  input: CreatePeerLinkInput,
  database: Database = db,
): Promise<
  NetworkingWriteResult<{
    linkId: string;
    outboundId: string;
    outboundTag: string;
    credentialGeneration: number;
  }>
> {
  const [destination] = await database
    .select()
    .from(peerInbound)
    .where(eq(peerInbound.id, input.destinationInboundId));
  if (!destination) {
    return {
      ok: false,
      reason: "not_found",
      message: "Destination peer inbound not found",
    };
  }
  if (destination.serverId === input.sourceServerId) {
    return {
      ok: false,
      reason: "invalid_link",
      message: "A link must target another server",
    };
  }
  const [duplicate] = await database
    .select({ id: peerLink.id })
    .from(peerLink)
    .where(
      and(
        eq(peerLink.sourceServerId, input.sourceServerId),
        eq(peerLink.destinationInboundId, input.destinationInboundId),
      ),
    );
  if (duplicate) {
    return {
      ok: false,
      reason: "duplicate",
      message: "This pair of servers already has a link to that peer inbound",
    };
  }
  const linkId = randomUUID();
  const outboundId = randomUUID();
  const outboundTag = managedRuntimeTag("peer_link", outboundId);
  let ciphertext: string;
  try {
    ciphertext = encryptManagedPeerCredential(
      linkId,
      1,
      peerSecret(destination.protocol),
    );
  } catch {
    return {
      ok: false,
      reason: "credential_key_unavailable",
      message:
        "Peer credentials cannot be encrypted until CERTIFICATE_MASTER_KEY is configured",
    };
  }
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
      destination AS (
        SELECT * FROM ${peerInbound}
        WHERE id = ${input.destinationInboundId}::text
          AND server_id <> ${input.sourceServerId}::text
      ),
      link AS (
        INSERT INTO ${peerLink} (
          id, source_server_id, destination_inbound_id
        )
        SELECT ${linkId}::text,
               ${input.sourceServerId}::text,
               destination.id
        FROM destination CROSS JOIN topology_cas
        WHERE NOT EXISTS (
          SELECT 1 FROM ${peerLink}
          WHERE source_server_id = ${input.sourceServerId}::text
            AND destination_inbound_id = destination.id
        )
        RETURNING *
      ),
      outbound AS (
        INSERT INTO ${managedOutbound} (
          id, server_id, kind, name, runtime_tag, link_id
        )
        SELECT ${outboundId}::text,
               link.source_server_id,
               'peer_link',
               ${input.name}::text,
               ${outboundTag}::text,
               link.id
        FROM link
        RETURNING *
      ),
      credential AS (
        INSERT INTO ${peerLinkCredential} (
          link_id, generation, state, credential_ciphertext
        )
        SELECT link.id, 1, 'active', ${ciphertext}::text
        FROM link
        RETURNING *
      )
      SELECT link.id, outbound.id AS outbound_id,
             outbound.runtime_tag AS outbound_tag,
             topology_cas.generation
      FROM link
      CROSS JOIN outbound
      CROSS JOIN credential
      CROSS JOIN topology_cas
    `,
  );
  if (rows[0]) {
    return {
      ok: true,
      generation: numeric(rows[0].generation),
      linkId: String(rows[0].id),
      outboundId: String(rows[0].outbound_id),
      outboundTag: String(rows[0].outbound_tag),
      credentialGeneration: 1,
    };
  }
  const [again] = await database
    .select({ id: peerLink.id })
    .from(peerLink)
    .where(
      and(
        eq(peerLink.sourceServerId, input.sourceServerId),
        eq(peerLink.destinationInboundId, input.destinationInboundId),
      ),
    );
  if (again) {
    return {
      ok: false,
      reason: "duplicate",
      message: "This pair of servers already has a link to that peer inbound",
    };
  }
  return conflictReason(database);
}

export async function updatePeerLinkDraft(
  id: string,
  name: string,
  expectedGeneration: number,
  database: Database = db,
): Promise<NetworkingWriteResult<{ linkId: string }>> {
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(expectedGeneration)},
      updated AS (
        UPDATE ${managedOutbound}
        SET name = ${name},
            revision = revision + 1,
            updated_at = now()
        WHERE link_id = ${id}::text
          AND kind = 'peer_link'
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING link_id
      ),
      link_update AS (
        UPDATE ${peerLink}
        SET revision = revision + 1, updated_at = now()
        WHERE id = ${id}::text
          AND EXISTS (SELECT 1 FROM updated)
        RETURNING id
      )
      SELECT link_update.id, topology_cas.generation
      FROM link_update CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) {
    const [existing] = await database
      .select({ id: peerLink.id })
      .from(peerLink)
      .where(eq(peerLink.id, id));
    if (!existing) {
      return { ok: false, reason: "not_found", message: "Link not found" };
    }
    return conflictReason(database);
  }
  return {
    ok: true,
    generation: numeric(rows[0].generation),
    linkId: String(rows[0].id),
  };
}

export async function rotatePeerLinkCredentialDraft(
  id: string,
  expectedGeneration: number,
  database: Database = db,
): Promise<
  NetworkingWriteResult<{ linkId: string; generationNumber: number }>
> {
  const [row] = await database
    .select({ link: peerLink, inbound: peerInbound })
    .from(peerLink)
    .innerJoin(peerInbound, eq(peerInbound.id, peerLink.destinationInboundId))
    .where(eq(peerLink.id, id));
  if (!row) {
    return { ok: false, reason: "not_found", message: "Link not found" };
  }
  const [latest] = await database
    .select({ generation: peerLinkCredential.generation })
    .from(peerLinkCredential)
    .where(eq(peerLinkCredential.linkId, id))
    .orderBy(desc(peerLinkCredential.generation))
    .limit(1);
  const next = (latest?.generation ?? 0) + 1;
  let ciphertext: string;
  try {
    ciphertext = encryptManagedPeerCredential(
      id,
      next,
      peerSecret(row.inbound.protocol),
    );
  } catch {
    return {
      ok: false,
      reason: "credential_key_unavailable",
      message:
        "Peer credentials cannot be encrypted until CERTIFICATE_MASTER_KEY is configured",
    };
  }
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(expectedGeneration)},
      retire AS (
        UPDATE ${peerLinkCredential}
        SET state = 'retiring'
        WHERE link_id = ${id}::text
          AND state = 'active'
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING 1
      ),
      added AS (
        INSERT INTO ${peerLinkCredential} (
          link_id, generation, state, credential_ciphertext
        )
        SELECT ${id}::text, ${next}::integer, 'active', ${ciphertext}::text
        FROM topology_cas
        RETURNING generation
      ),
      link_update AS (
        UPDATE ${peerLink}
        SET revision = revision + 1, updated_at = now()
        WHERE id = ${id}::text AND EXISTS (SELECT 1 FROM added)
        RETURNING id
      ),
      outbound_update AS (
        UPDATE ${managedOutbound}
        SET revision = revision + 1, updated_at = now()
        WHERE link_id = ${id}::text AND EXISTS (SELECT 1 FROM added)
        RETURNING 1
      )
      SELECT link_update.id, added.generation AS generation_number,
             topology_cas.generation
      FROM link_update
      CROSS JOIN added
      CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) {
    if (await peerLinkExists(id, database)) return conflictReason(database);
    return { ok: false, reason: "not_found", message: "Link not found" };
  }
  return {
    ok: true,
    generation: numeric(rows[0].generation),
    linkId: String(rows[0].id),
    generationNumber: numeric(rows[0].generation_number),
  };
}

async function peerLinkExists(
  id: string,
  database: Database,
): Promise<boolean> {
  const [row] = await database
    .select({ id: peerLink.id })
    .from(peerLink)
    .where(eq(peerLink.id, id));
  return Boolean(row);
}

export async function deletePeerLinkDraft(
  id: string,
  expectedGeneration: number,
  database: Database = db,
): Promise<NetworkingDeleteResult> {
  const [link] = await database
    .select()
    .from(peerLink)
    .where(eq(peerLink.id, id));
  if (!link) {
    return { ok: false, reason: "not_found", message: "Link not found" };
  }
  if (
    await configVersionReferencesAny(database, [
      { outbounds: [{ linkId: id }] },
      { peerInbounds: [{ admissions: [{ linkId: id }] }] },
    ])
  ) {
    return {
      ok: false,
      reason: "referenced",
      message: "A saved routing draft still references this link",
    };
  }
  const [claim] = await database
    .select({ serverId: managedRolloutClaim.serverId })
    .from(managedRolloutClaim)
    .where(inArray(managedRolloutClaim.serverId, [link.sourceServerId]))
    .limit(1);
  if (claim) {
    return {
      ok: false,
      reason: "referenced",
      message: "A rollout still claims the source server",
    };
  }
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(expectedGeneration)},
      delete_outbound AS (
        DELETE FROM ${managedOutbound}
        WHERE link_id = ${id}::text
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING id
      ),
      delete_link AS (
        DELETE FROM ${peerLink}
        WHERE id = ${id}::text
          AND EXISTS (SELECT 1 FROM delete_outbound)
        RETURNING id
      )
      SELECT delete_link.id, topology_cas.generation
      FROM delete_link CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) return conflictReason(database);
  return { ok: true, generation: numeric(rows[0].generation) };
}

// --- Named direct outbounds -------------------------------------------------

function directDialOptions(
  input: SaveManagedOutboundInput,
): Record<string, JsonValue> {
  return {
    ...(input.bindInterface ? { bind_interface: input.bindInterface } : {}),
    ...directProfileIpFamilyDialFields(input.ipFamily),
  };
}

export async function saveManagedOutboundDraft(
  input: SaveManagedOutboundInput,
  database: Database = db,
): Promise<NetworkingWriteResult<{ outboundId: string }>> {
  const dialOptions = directDialOptions(input);
  if (input.id) {
    const [existing] = await database
      .select()
      .from(managedOutbound)
      .where(eq(managedOutbound.id, input.id));
    if (!existing) {
      return { ok: false, reason: "not_found", message: "Outbound not found" };
    }
    if (existing.kind !== "direct_profile") {
      return {
        ok: false,
        reason: "unsupported",
        message: "Peer link outbounds are edited through their link",
      };
    }
    const rows = await executeRows(
      database,
      sql`
        WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
        updated AS (
          UPDATE ${managedOutbound}
          SET name = ${input.name},
              server_id = ${input.serverId},
              dial_options = ${jsonParam(dialOptions)},
              revision = revision + 1,
              updated_at = now()
          WHERE id = ${input.id}::text
            AND kind = 'direct_profile'
            AND EXISTS (SELECT 1 FROM topology_cas)
          RETURNING id
        )
        SELECT updated.id, topology_cas.generation
        FROM updated CROSS JOIN topology_cas
      `,
    );
    if (!rows[0]) return conflictReason(database);
    return {
      ok: true,
      generation: numeric(rows[0].generation),
      outboundId: String(rows[0].id),
    };
  }

  const id = randomUUID();
  const runtimeTag = managedRuntimeTag("direct_profile", id);
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
      inserted AS (
        INSERT INTO ${managedOutbound} (
          id, server_id, kind, name, runtime_tag, dial_options
        )
        SELECT ${id}::text,
               ${input.serverId}::text,
               'direct_profile',
               ${input.name}::text,
               ${runtimeTag}::text,
               ${jsonParam(dialOptions)}
        FROM topology_cas
        RETURNING id
      )
      SELECT inserted.id, topology_cas.generation
      FROM inserted CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) return conflictReason(database);
  return {
    ok: true,
    generation: numeric(rows[0].generation),
    outboundId: String(rows[0].id),
  };
}

export async function deleteManagedOutboundDraft(
  id: string,
  expectedGeneration: number,
  database: Database = db,
): Promise<NetworkingDeleteResult> {
  const [existing] = await database
    .select()
    .from(managedOutbound)
    .where(eq(managedOutbound.id, id));
  if (!existing) {
    return { ok: false, reason: "not_found", message: "Outbound not found" };
  }
  if (existing.kind !== "direct_profile") {
    return {
      ok: false,
      reason: "unsupported",
      message: "Delete the peer link to remove its outbound",
    };
  }
  if (
    await configVersionReferencesAny(database, [
      { outbounds: [{ outboundId: id }] },
    ])
  ) {
    return {
      ok: false,
      reason: "referenced",
      message: "A saved routing draft still references this outbound",
    };
  }
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(expectedGeneration)},
      removed AS (
        DELETE FROM ${managedOutbound}
        WHERE id = ${id}::text
          AND kind = 'direct_profile'
          AND EXISTS (SELECT 1 FROM topology_cas)
        RETURNING id
      )
      SELECT removed.id, topology_cas.generation
      FROM removed CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) return conflictReason(database);
  return { ok: true, generation: numeric(rows[0].generation) };
}

// --- Rule-set assets --------------------------------------------------------

function decodeRuleSetAsset(input: ImportRuleSetAssetInput):
  | { ok: true; bytes: Buffer; sha256: string }
  | {
      ok: false;
      reason: "invalid_asset" | "asset_too_large";
      message: string;
    } {
  const normalized = input.contentBase64.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) {
    return {
      ok: false,
      reason: "invalid_asset",
      message: "The SRS content must be padded base64",
    };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return {
      ok: false,
      reason: "invalid_asset",
      message: "The SRS content is not valid base64",
    };
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length > 512 * 1024) {
    return {
      ok: false,
      reason: "asset_too_large",
      message: "The SRS asset must be between 1 byte and 512 KiB",
    };
  }
  if (bytes.toString("base64") !== normalized) {
    return {
      ok: false,
      reason: "invalid_asset",
      message: "The SRS content is not canonical base64",
    };
  }
  return {
    ok: true,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function importRuleSetAssetDraft(
  input: ImportRuleSetAssetInput,
  database: Database = db,
): Promise<
  | {
      ok: true;
      ruleSetId: string;
      version: string;
      sha256: string;
      sizeBytes: number;
    }
  | { ok: false; reason: string; message: string }
> {
  const decoded = decodeRuleSetAsset(input);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason, message: decoded.message };
  }
  try {
    const [row] = await database
      .insert(managedRuleSetAsset)
      .values({
        ruleSetId: input.ruleSetId,
        version: input.version,
        format: "binary",
        source: input.source,
        contentBase64: decoded.bytes.toString("base64"),
        sizeBytes: decoded.bytes.length,
        sha256: decoded.sha256,
      })
      .returning();
    return {
      ok: true,
      ruleSetId: row!.ruleSetId,
      version: row!.version,
      sha256: row!.sha256,
      sizeBytes: row!.sizeBytes,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "23505") {
      return {
        ok: false,
        reason: "duplicate_rule_set",
        message: "That rule-set version is already imported",
      };
    }
    throw error;
  }
}

// --- Immutable routing draft ------------------------------------------------

export interface SaveRoutingDraftInput {
  configVersionId: string;
  serverId: string;
  version: number;
  intent: JsonValue;
  intentDigest: string;
  subscriberNodeIds: string[];
  expectedTopologyGeneration: number;
}

export async function saveRoutingDraft(
  input: SaveRoutingDraftInput,
  database: Database = db,
): Promise<
  NetworkingWriteResult<{ configVersionId: string; version: number }>
> {
  const rows = await executeRows(
    database,
    sql`
      WITH ${currentGenerationCte(input.expectedTopologyGeneration)},
      inserted AS (
        INSERT INTO ${managedConfigVersion} (
          id, server_id, version, schema_version, intent,
          intent_digest, subscriber_node_ids
        )
        SELECT ${input.configVersionId}::text,
               ${input.serverId}::text,
               ${input.version}::integer,
               1,
               ${jsonParam(input.intent)},
               ${input.intentDigest}::text,
               ${jsonParam(input.subscriberNodeIds)}
        FROM topology_cas
        WHERE NOT EXISTS (
          SELECT 1 FROM ${managedConfigVersion}
          WHERE server_id = ${input.serverId}::text
            AND version = ${input.version}::integer
        )
        RETURNING id, version
      )
      SELECT inserted.id, inserted.version, topology_cas.generation
      FROM inserted CROSS JOIN topology_cas
    `,
  );
  if (!rows[0]) {
    const [existing] = await database
      .select({ id: managedConfigVersion.id })
      .from(managedConfigVersion)
      .where(
        and(
          eq(managedConfigVersion.serverId, input.serverId),
          eq(managedConfigVersion.version, input.version),
        ),
      );
    if (existing) {
      return {
        ok: false,
        reason: "duplicate",
        message: "Another draft was saved at the same version",
      };
    }
    return conflictReason(database);
  }
  return {
    ok: true,
    generation: numeric(rows[0].generation),
    configVersionId: String(rows[0].id),
    version: numeric(rows[0].version),
  };
}
