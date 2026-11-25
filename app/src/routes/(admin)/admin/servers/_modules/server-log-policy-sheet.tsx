"use client";

import { RefreshCwIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import {
  ServerLogPolicyPanel,
  type ServerLogPolicyController,
} from "./server-log-policy-panel";

export interface ServerLogPolicySheetProps {
  server: ServerDTO;
  controller: ServerLogPolicyController;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** Right-side sheet for the per-source log level controls. */
export function ServerLogPolicySheet({
  server,
  controller,
  open,
  onOpenChange,
}: ServerLogPolicySheetProps): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{m.agent_logs_policy_title()}</SheetTitle>
          <SheetDescription>
            {m.agent_logs_policy_description()}
          </SheetDescription>
        </SheetHeader>
        <div className="flex shrink-0 items-center gap-2 px-6 pb-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  loading={controller.refreshing}
                  onClick={() => void controller.refresh()}
                />
              }
            >
              <RefreshCwIcon />
              {m.agent_logs_policy_refresh()}
            </TooltipTrigger>
            <TooltipPopup>
              {m.agent_logs_policy_sheet_refresh_hint()}
            </TooltipPopup>
          </Tooltip>
        </div>
        <SheetPanel className="pt-2">
          <ServerLogPolicyPanel server={server} controller={controller} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
