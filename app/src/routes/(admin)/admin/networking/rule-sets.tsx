import { MANAGED_SNAPSHOT_LIMITS } from "@blossom/contracts/agent-config-v3";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDownIcon, FileUpIcon, GlobeIcon, PlusIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  PageContent,
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderTitle,
  PageToolbar,
} from "@/components/app-shell/page-header";
import { TableSkeleton } from "@/components/app-shell/skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBytes } from "@/lib/format";
import { ruleSetOrigin } from "@/lib/github-rule-set-catalog";
import type { RuleSetSource } from "@/lib/srs";
import { m } from "@/paraglide/messages";
import { getRuleSetAssetSource } from "@/query/networking-rule-sets";

import { RuleSetCustomSheet } from "./_modules/rule-set-custom-sheet";
import { RuleSetOfficialSheet } from "./_modules/rule-set-official-sheet";
import {
  RuleSetTable,
  type RuleSetOriginFilter,
  type RuleSetRowView,
} from "./_modules/rule-set-table";
import { RuleSetUploadDialog } from "./_modules/rule-set-upload-dialog";
import {
  useInvalidateNetworking,
  useNetworkingWorkspace,
} from "./_modules/use-networking-workspace";

export const Route = createFileRoute("/(admin)/admin/networking/rule-sets")({
  staticData: {
    crumb: () => m.admin_workspace_networking_rule_sets(),
  },
  component: RouteComponent,
});

type AddFlow = "official" | "custom" | "upload" | null;

interface CustomPrefillView {
  ruleSetId: string;
  version: string;
  source: RuleSetSource;
}

function RouteComponent(): React.ReactElement {
  const { data, isPending, isError, refetch } = useNetworkingWorkspace();
  const invalidate = useInvalidateNetworking();
  const [filter, setFilter] = useState("");
  const [origin, setOrigin] = useState<RuleSetOriginFilter>("all");
  const [addFlow, setAddFlow] = useState<AddFlow>(null);
  const [customPrefill, setCustomPrefill] = useState<CustomPrefillView | null>(
    null,
  );
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  const serverNames = new Map(
    (data?.servers ?? []).map((server) => [server.id, server.name]),
  );
  const rows = (data?.ruleSets ?? []).filter(
    (row) =>
      (origin === "all" || ruleSetOrigin(row.source) === origin) &&
      (filter.trim() === "" ||
        row.ruleSetId.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const totalBytes =
    data?.ruleSets.reduce((sum, row) => sum + row.sizeBytes, 0) ?? 0;

  const closeAdd = () => {
    setAddFlow(null);
    setCustomPrefill(null);
  };

  const onSaved = async () => invalidate();

  const loadDuplicate = async (row: RuleSetRowView) => {
    setDuplicateError(null);
    const result = await getRuleSetAssetSource({
      data: { ruleSetId: row.ruleSetId, version: row.version },
    });
    if (!result.ok) {
      setDuplicateError(
        result.reason === "unsupported"
          ? m.admin_networking_rulesets_table_duplicate_unsupported()
          : m.admin_networking_write_not_found(),
      );
      return;
    }
    setCustomPrefill({
      ruleSetId: row.ruleSetId,
      version: row.version,
      source: result.source,
    });
    setAddFlow("custom");
  };

  return (
    <>
      <PageHeader>
        <div className="flex min-w-0 flex-col">
          <PageHeaderTitle>
            {m.admin_workspace_networking_rule_sets()}
          </PageHeaderTitle>
          <PageHeaderDescription>
            {m.admin_networking_rulesets_description()}
          </PageHeaderDescription>
        </div>
        <PageHeaderActions>
          <Menu>
            <MenuTrigger
              render={
                <Button size="sm">
                  <PlusIcon />
                  {m.admin_networking_rulesets_table_add()}
                  <ChevronDownIcon />
                </Button>
              }
            />
            <MenuPopup align="end">
              <MenuItem onClick={() => setAddFlow("official")}>
                <GlobeIcon />
                {m.admin_networking_rulesets_table_add_official()}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setCustomPrefill(null);
                  setAddFlow("custom");
                }}
              >
                {m.admin_networking_rulesets_table_add_custom()}
              </MenuItem>
              <MenuItem onClick={() => setAddFlow("upload")}>
                <FileUpIcon />
                {m.admin_networking_rulesets_table_add_upload()}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </PageHeaderActions>
      </PageHeader>

      <PageToolbar>
        <input
          aria-label={m.admin_networking_rulesets_table_filter_placeholder()}
          className="h-7 w-56 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
          onChange={(event) => setFilter(event.target.value)}
          placeholder={m.admin_networking_rulesets_table_filter_placeholder()}
          type="search"
          value={filter}
        />
        <Select
          onValueChange={(value) => setOrigin(value as RuleSetOriginFilter)}
          value={origin}
        >
          <SelectTrigger
            aria-label={m.admin_networking_rulesets_table_origin_filter()}
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">
              {m.admin_networking_rulesets_table_origin_all()}
            </SelectItem>
            <SelectItem value="official">
              {m.admin_networking_rulesets_origin_official()}
            </SelectItem>
            <SelectItem value="custom">
              {m.admin_networking_rulesets_origin_custom()}
            </SelectItem>
            <SelectItem value="upload">
              {m.admin_networking_rulesets_origin_upload()}
            </SelectItem>
          </SelectPopup>
        </Select>
        <span className="ms-auto hidden text-xs text-muted-foreground sm:block">
          {m.admin_networking_rulesets_table_summary({
            count: rows.length,
            bytes: formatBytes(totalBytes),
            budget: formatBytes(
              MANAGED_SNAPSHOT_LIMITS.maxRuleSetAggregateRawBytes,
            ),
          })}
        </span>
      </PageToolbar>

      <PageContent width="flush">
        {duplicateError ? (
          <div className="border-b px-4 py-2 lg:px-6">
            <Alert variant="error">
              <AlertDescription>{duplicateError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {data?.activationEnabled === false ? (
          <div className="border-b px-4 py-2 lg:px-6">
            <Alert variant="info">
              <AlertTitle>
                {m.admin_networking_activation_disabled_title()}
              </AlertTitle>
              <AlertDescription>
                {m.admin_networking_activation_disabled_description()}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {isPending ? (
          <TableSkeleton columns={7} rows={8} />
        ) : isError || !data ? (
          <div className="flex flex-col items-start gap-3 p-4 lg:p-6">
            <p className="text-sm text-destructive">
              {m.admin_networking_load_error()}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {m.admin_networking_action_retry()}
            </Button>
          </div>
        ) : (
          <RuleSetTable
            onAddCustom={() => {
              setCustomPrefill(null);
              setAddFlow("custom");
            }}
            onAddOfficial={() => setAddFlow("official")}
            onAddUpload={() => setAddFlow("upload")}
            onDuplicate={(row) => {
              void loadDuplicate(row);
            }}
            rows={rows}
            serverNames={serverNames}
          />
        )}
      </PageContent>

      <RuleSetOfficialSheet
        existing={data?.ruleSets ?? []}
        onImported={onSaved}
        onOpenUpload={() => {
          setAddFlow("upload");
        }}
        onOpenChange={(open) => {
          if (!open && addFlow === "official") closeAdd();
        }}
        open={addFlow === "official"}
      />
      <RuleSetCustomSheet
        key={
          customPrefill
            ? `${customPrefill.ruleSetId}:${customPrefill.version}`
            : "new"
        }
        existing={data?.ruleSets ?? []}
        onOpenChange={(open) => {
          if (!open && addFlow === "custom") closeAdd();
        }}
        onSaved={onSaved}
        open={addFlow === "custom"}
        prefill={customPrefill}
      />
      <RuleSetUploadDialog
        onOpenChange={(open) => {
          if (!open && addFlow === "upload") closeAdd();
        }}
        onUploaded={onSaved}
        open={addFlow === "upload"}
        preset={null}
      />
    </>
  );
}
