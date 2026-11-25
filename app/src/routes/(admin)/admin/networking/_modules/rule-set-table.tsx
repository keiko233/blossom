import {
  CopyIcon,
  EllipsisIcon,
  FileUpIcon,
  GlobeIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatBytes, formatDateTime } from "@/lib/format";
import { ruleSetOrigin } from "@/lib/github-rule-set-catalog";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
export interface RuleSetRowView {
  ruleSetId: string;
  version: string;
  format: "binary";
  source: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  usedByServerIds: string[];
}
export type RuleSetOriginFilter = "all" | "official" | "custom" | "upload";

export function ruleSetRuntimeTag(ruleSetId: string): string {
  return `rule-set-${ruleSetId}`;
}

function originLabel(origin: ReturnType<typeof ruleSetOrigin>): string {
  if (origin === "official")
    return m.admin_networking_rulesets_origin_official();
  if (origin === "custom") return m.admin_networking_rulesets_origin_custom();
  return m.admin_networking_rulesets_origin_upload();
}

export function RuleSetOriginBadge({
  source,
}: {
  source: string;
}): React.ReactElement {
  const origin = ruleSetOrigin(source);
  return (
    <Badge
      size="sm"
      variant={
        origin === "official"
          ? "info"
          : origin === "custom"
            ? "success"
            : "outline"
      }
    >
      {originLabel(origin)}
    </Badge>
  );
}

export interface RuleSetTableProps {
  rows: readonly RuleSetRowView[];
  serverNames: ReadonlyMap<string, string>;
  onAddOfficial: () => void;
  onAddCustom: () => void;
  onAddUpload: () => void;
  onDuplicate: (row: RuleSetRowView) => void;
}

async function copyText(
  value: string,
  success: string,
  failure: string,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toastManager.add({ type: "success", title: success });
  } catch {
    toastManager.add({ type: "error", title: failure });
  }
}

function usedByLabel(
  serverIds: readonly string[],
  serverNames: ReadonlyMap<string, string>,
): string {
  if (serverIds.length === 0)
    return m.admin_networking_rulesets_table_used_by_none();
  const names = serverIds.map((id) => serverNames.get(id) ?? id);
  return m.admin_networking_rulesets_table_used_by({
    count: serverIds.length,
    servers: names.join(", "),
  });
}

export function RuleSetTable({
  rows,
  serverNames,
  onAddOfficial,
  onAddCustom,
  onAddUpload,
  onDuplicate,
}: RuleSetTableProps): React.ReactElement {
  const [inspected, setInspected] = useState<RuleSetRowView | null>(null);
  const showRail = useMediaQuery("xl");

  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>
            {m.admin_networking_rulesets_table_empty_title()}
          </EmptyTitle>
          <EmptyDescription>
            {m.admin_networking_rulesets_table_empty_description()}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={onAddOfficial}>
              <GlobeIcon />
              {m.admin_networking_rulesets_table_add_official()}
            </Button>
            <Button size="sm" variant="outline" onClick={onAddCustom}>
              {m.admin_networking_rulesets_table_add_custom()}
            </Button>
            <Button size="sm" variant="outline" onClick={onAddUpload}>
              <FileUpIcon />
              {m.admin_networking_rulesets_table_add_upload()}
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    );
  }

  const table = (
    <Table data-slot="rule-set-table" variant="pane">
      <TableHeader>
        <TableRow>
          <TableHead>{m.admin_networking_rulesets_table_col_id()}</TableHead>
          <TableHead>
            {m.admin_networking_rulesets_table_col_version()}
          </TableHead>
          <TableHead>
            {m.admin_networking_rulesets_table_col_origin()}
          </TableHead>
          <TableHead className="text-right">
            {m.admin_networking_rulesets_table_col_size()}
          </TableHead>
          <TableHead>{m.admin_networking_rulesets_table_col_sha()}</TableHead>
          <TableHead>
            {m.admin_networking_rulesets_table_col_used_by()}
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            {m.admin_networking_rulesets_table_col_created()}
          </TableHead>
          <TableHead className="w-10">
            <span className="sr-only">
              {m.admin_networking_rulesets_table_actions()}
            </span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const key = `${row.ruleSetId}:${row.version}`;
          const selected =
            inspected?.ruleSetId === row.ruleSetId &&
            inspected.version === row.version;
          return (
            <TableRow
              data-state={selected ? "selected" : undefined}
              key={key}
              onClick={() => setInspected(row)}
            >
              <TableCell>
                <button
                  className="rounded-sm font-mono text-xs font-medium focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:outline-none"
                  onClick={(event) => {
                    event.stopPropagation();
                    setInspected(row);
                  }}
                  type="button"
                >
                  {row.ruleSetId}
                </button>
              </TableCell>
              <TableCell className="font-mono text-xs">{row.version}</TableCell>
              <TableCell>
                <RuleSetOriginBadge source={row.source} />
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {formatBytes(row.sizeBytes)}
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.sha256.slice(0, 12)}
                  </span>
                  <Button
                    aria-label={m.admin_networking_rulesets_table_copy_sha()}
                    size="icon-xs"
                    variant="ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(
                        row.sha256,
                        m.admin_networking_rulesets_table_toast_sha_copied(),
                        m.admin_networking_rulesets_table_toast_copy_failed(),
                      );
                    }}
                  >
                    <CopyIcon />
                  </Button>
                </span>
              </TableCell>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="cursor-default text-xs text-muted-foreground tabular-nums" />
                    }
                  >
                    {m.admin_networking_rulesets_table_used_by_count({
                      count: row.usedByServerIds.length,
                    })}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {usedByLabel(row.usedByServerIds, serverNames)}
                  </TooltipPopup>
                </Tooltip>
              </TableCell>
              <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                {formatDateTime(row.createdAt)}
              </TableCell>
              <TableCell>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        aria-label={m.admin_networking_rulesets_table_actions()}
                        size="icon-xs"
                        variant="ghost"
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      onClick={() =>
                        void copyText(
                          ruleSetRuntimeTag(row.ruleSetId),
                          m.admin_networking_rulesets_table_toast_tag_copied(),
                          m.admin_networking_rulesets_table_toast_copy_failed(),
                        )
                      }
                    >
                      <CopyIcon />
                      {m.admin_networking_rulesets_table_copy_tag()}
                    </MenuItem>
                    <MenuItem
                      onClick={() =>
                        void copyText(
                          row.sha256,
                          m.admin_networking_rulesets_table_toast_sha_copied(),
                          m.admin_networking_rulesets_table_toast_copy_failed(),
                        )
                      }
                    >
                      <CopyIcon />
                      {m.admin_networking_rulesets_table_copy_sha()}
                    </MenuItem>
                    <MenuItem onClick={() => onDuplicate(row)}>
                      {m.admin_networking_rulesets_table_duplicate()}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

  if (!showRail) {
    return (
      <>
        {table}
        <RuleSetInspector
          row={inspected}
          serverNames={serverNames}
          onOpenChange={(open) => {
            if (!open) setInspected(null);
          }}
        />
      </>
    );
  }

  return (
    <div
      className={cn(
        "grid",
        inspected
          ? "xl:grid-cols-[minmax(0,1fr)_22rem]"
          : "xl:grid-cols-[minmax(0,1fr)]",
      )}
    >
      <div className="min-w-0">{table}</div>
      {inspected ? (
        <aside
          className="border-s"
          data-slot="rule-set-inspector"
          aria-label={m.admin_networking_rulesets_table_inspector_description()}
        >
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="min-w-0 truncate font-mono text-sm">
              {inspected.ruleSetId}
            </span>
            <Button
              aria-label={m.admin_access_close()}
              size="icon-xs"
              variant="ghost"
              onClick={() => setInspected(null)}
            >
              <XIcon />
            </Button>
          </div>
          <InspectorBody row={inspected} serverNames={serverNames} />
        </aside>
      ) : null}
    </div>
  );
}

function InspectorRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm break-all", mono && "font-mono text-xs")}>
        {children}
      </dd>
    </div>
  );
}

function InspectorBody({
  row,
  serverNames,
}: {
  row: RuleSetRowView;
  serverNames: ReadonlyMap<string, string>;
}): React.ReactElement {
  return (
    <div className="p-4">
      <dl className="flex flex-col gap-4">
        <InspectorRow label={m.admin_networking_rulesets_table_col_version()}>
          <span className="font-mono text-xs">{row.version}</span>
        </InspectorRow>
        <InspectorRow label={m.admin_networking_rulesets_table_col_origin()}>
          <RuleSetOriginBadge source={row.source} />
        </InspectorRow>
        <InspectorRow label={m.admin_networking_rulesets_table_col_size()}>
          <span className="tabular-nums">{formatBytes(row.sizeBytes)}</span>
        </InspectorRow>
        <InspectorRow label={m.admin_networking_rulesets_table_col_sha()}>
          <span className="font-mono text-xs">{row.sha256}</span>
        </InspectorRow>
        <InspectorRow
          label={m.admin_networking_rulesets_table_inspector_source()}
        >
          <span className="font-mono text-xs">{row.source}</span>
        </InspectorRow>
        <InspectorRow label={m.admin_networking_rulesets_table_col_created()}>
          {formatDateTime(row.createdAt)}
        </InspectorRow>
        <InspectorRow label={m.admin_networking_rulesets_table_col_used_by()}>
          {usedByLabel(row.usedByServerIds, serverNames)}
        </InspectorRow>
        <InspectorRow label={m.admin_networking_rulesets_table_inspector_tag()}>
          <span className="font-mono text-xs">
            {ruleSetRuntimeTag(row.ruleSetId)}
          </span>
        </InspectorRow>
      </dl>
    </div>
  );
}

function RuleSetInspector({
  row,
  serverNames,
  onOpenChange,
}: {
  row: RuleSetRowView | null;
  serverNames: ReadonlyMap<string, string>;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Sheet open={row !== null} onOpenChange={onOpenChange}>
      <SheetPopup className="sm:max-w-md" side="right">
        <SheetHeader>
          <SheetTitle className="font-mono">{row?.ruleSetId}</SheetTitle>
          <SheetDescription>
            {m.admin_networking_rulesets_table_inspector_description()}
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          {row ? <InspectorBody row={row} serverNames={serverNames} /> : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
