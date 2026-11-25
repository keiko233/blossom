import type { agentWsTelemetrySnapshotPayloadSchema } from "@blossom/contracts/agent-ws";
import type React from "react";
import type { z } from "zod";

import {
  SectionHeader,
  SectionTitle,
} from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { m } from "@/paraglide/messages";

type Snapshot = z.infer<typeof agentWsTelemetrySnapshotPayloadSchema>;

export type Inspection = Omit<Snapshot, "listeners"> & {
  listeners: (Snapshot["listeners"][number] & { overlapsNode: boolean })[];
};

export interface NetworkInspectionProps {
  snapshot: Inspection | undefined;
  isPending: boolean;
  isError: boolean;
}

/** Two dense tables of the agent network namespace, requested explicitly. */
export function NetworkInspection({
  snapshot,
  isPending,
  isError,
}: NetworkInspectionProps): React.ReactElement {
  return (
    <section
      data-slot="network-inspection"
      className="flex flex-col gap-3 border-t pt-6"
      aria-labelledby="network-inspection-title"
    >
      <SectionHeader>
        <SectionTitle id="network-inspection-title">
          {m.admin_server_ws_network_inspection()}
        </SectionTitle>
        {snapshot ? (
          <span className="text-xs text-muted-foreground">
            {m.server_live_namespace()}
            {snapshot.partial ? ` · ${m.server_live_partial()}` : ""}
          </span>
        ) : null}
      </SectionHeader>

      {isPending ? (
        <TableSkeleton rows={4} columns={4} />
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          {m.server_live_unavailable()}
        </p>
      ) : !snapshot ? (
        <p className="text-sm text-muted-foreground">
          {m.admin_server_ws_inspection_empty()}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{m.server_live_ports()}</h3>
            {snapshot.listeners.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {m.server_live_empty()}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.admin_server_ws_protocol()}</TableHead>
                    <TableHead>{m.admin_server_ws_address()}</TableHead>
                    <TableHead>{m.admin_server_ws_port()}</TableHead>
                    <TableHead>{m.admin_server_ws_note()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshot.listeners.map(
                    ({ protocol, address, port, overlapsNode }) => (
                      <TableRow key={`${protocol}/${address}/${port}`}>
                        <TableCell className="font-mono">
                          {protocol.toUpperCase()}
                        </TableCell>
                        <TableCell className="font-mono">
                          {address.includes(":") ? `[${address}]` : address}
                        </TableCell>
                        <TableCell className="font-mono tabular-nums">
                          {port}
                        </TableCell>
                        <TableCell>
                          {overlapsNode ? (
                            <Badge size="sm" variant="warning">
                              {m.server_live_overlap()}
                            </Badge>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t pt-6">
            <h3 className="text-sm font-semibold">
              {m.server_live_interfaces()}
            </h3>
            {snapshot.interfaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {m.server_live_empty()}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.admin_server_ws_interface()}</TableHead>
                    <TableHead>{m.admin_server_ws_address()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshot.interfaces.map(({ name, address }) => (
                    <TableRow key={`${name}/${address}`}>
                      <TableCell className="font-mono">{name}</TableCell>
                      <TableCell className="font-mono wrap-anywhere">
                        {address}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
