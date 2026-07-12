import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

export interface TrafficTableRecord {
  id: string;
  createdAt: Date | string | number;
  /**
   * Resolved source name for display. Prefer the node name when present; fall
   * back to the server name (marked as a server) when only the server is
   * known (legacy multi-inbound records where the node has been moved /
   * deleted); finally `(deleted)` when neither survives.
   */
  sourceName: string | null;
  /** Whether the resolved source is a server rather than a node. */
  isServer: boolean;
  uplinkBytes: number;
  downlinkBytes: number;
}

export interface SubscriptionTrafficTableProps {
  records: TrafficTableRecord[];
}

export function SubscriptionTrafficTable({
  records,
}: SubscriptionTrafficTableProps) {
  if (records.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {m.component_subscription_traffic_empty()}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.component_subscription_traffic_col_time()}</TableHead>
          <TableHead>{m.component_subscription_traffic_col_source()}</TableHead>
          <TableHead>{m.component_subscription_traffic_col_uplink()}</TableHead>
          <TableHead>
            {m.component_subscription_traffic_col_downlink()}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={record.id}>
            <TableCell>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(record.createdAt)}
              </span>
            </TableCell>
            <TableCell>
              {record.sourceName ? (
                record.isServer ? (
                  <span>
                    {record.sourceName}
                    <span className="text-muted-foreground">
                      {m.component_subscription_traffic_server_suffix()}
                    </span>
                  </span>
                ) : (
                  record.sourceName
                )
              ) : (
                <span className="text-muted-foreground">
                  {m.component_subscription_traffic_node_deleted()}
                </span>
              )}
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs">
                {formatBytes(record.uplinkBytes)}
              </span>
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs">
                {formatBytes(record.downlinkBytes)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
