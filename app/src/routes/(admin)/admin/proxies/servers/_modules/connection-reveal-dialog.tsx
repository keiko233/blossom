import { CopyIcon, DownloadIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

/**
 * One-time installer material. The parent keeps this in component state only
 * and clears it on close; it is never written to storage, a URL, or telemetry.
 */
export type ConnectionReveal =
  | {
      kind: "secret";
      secret: string;
      downloadPath: string;
      grantId: string;
      expiresAt: Date | string;
    }
  | {
      kind: "script";
      script: { filename: string; content: string };
      downloadPath: string;
      grantId: string;
      expiresAt: Date | string;
    };

export interface ConnectionRevealDialogProps {
  reveal: ConnectionReveal | null;
  onClose: () => void;
}

/**
 * Ephemeral reveal for an enrollment secret or inline installer. The content
 * unmounts as soon as the dialog closes, matching the one-time credential
 * contract.
 */
export function ConnectionRevealDialog({
  reveal,
  onClose,
}: ConnectionRevealDialogProps): React.ReactElement | null {
  const [copying, setCopying] = useState(false);

  if (!reveal) {
    return null;
  }

  const expires = formatDateTime(reveal.expiresAt);
  const body = reveal.kind === "secret" ? reveal.secret : reveal.script.content;

  const copy = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(body);
      toastManager.add({
        type: "success",
        title: m.admin_proxies_servers_connection_toast_copied(),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_proxies_servers_connection_toast_copy_failed(),
      });
    } finally {
      setCopying(false);
    }
  };

  const downloadInline = () => {
    if (reveal.kind !== "script") {
      return;
    }
    const url = URL.createObjectURL(
      new Blob([reveal.script.content], {
        type: "text/x-shellscript;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reveal.script.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent data-slot="connection-reveal-dialog">
        <DialogHeader>
          <DialogTitle>
            {reveal.kind === "secret"
              ? m.admin_proxies_servers_connection_reveal_secret_title()
              : m.admin_proxies_servers_connection_reveal_script_title()}
          </DialogTitle>
          <DialogDescription>
            {reveal.kind === "secret"
              ? m.admin_proxies_servers_connection_reveal_secret_description({
                  date: expires,
                })
              : m.admin_proxies_servers_connection_reveal_script_description({
                  date: expires,
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6">
          <Alert variant="warning">
            <AlertTitle>
              {m.admin_proxies_servers_connection_reveal_one_time()}
            </AlertTitle>
            <AlertDescription>
              {reveal.kind === "secret"
                ? m.admin_proxies_servers_connection_reveal_secret_warning()
                : m.admin_proxies_servers_connection_reveal_script_warning()}
            </AlertDescription>
          </Alert>

          {reveal.kind === "secret" ? (
            <>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/32 p-3">
                <code className="min-w-0 flex-1 font-mono text-xs break-all">
                  {reveal.secret}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  aria-label={m.admin_proxies_servers_connection_reveal_copy()}
                  loading={copying}
                  onClick={() => void copy()}
                >
                  <CopyIcon />
                </Button>
              </div>
              <Button
                variant="outline"
                render={
                  <a
                    href={reveal.downloadPath}
                    download="blossom-agent-install.sh"
                  />
                }
              >
                <DownloadIcon />
                {m.admin_proxies_servers_connection_reveal_download_fixed()}
              </Button>
              <p className="text-sm text-muted-foreground">
                {m.admin_proxies_servers_connection_reveal_secret_instructions()}
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={copying}
                  onClick={() => void copy()}
                >
                  <CopyIcon />
                  {m.admin_proxies_servers_connection_reveal_copy()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={downloadInline}
                >
                  <DownloadIcon />
                  {m.admin_proxies_servers_connection_reveal_download_inline()}
                </Button>
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/32 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                {reveal.script.content}
              </pre>
            </>
          )}
        </div>

        <DialogFooter>
          <DialogClose
            render={<Button variant="secondary" />}
            onClick={() => onClose()}
          >
            {m.admin_proxies_servers_connection_reveal_done()}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
