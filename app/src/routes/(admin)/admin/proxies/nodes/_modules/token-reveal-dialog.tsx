import { CopyIcon } from "lucide-react";
import { createCallable } from "react-call";

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
import { m } from "@/paraglide/messages";

/** Matches the dialog popup's exit animation before react-call unmounts it. */
const EXIT_MS = 200;

export interface TokenRevealProps {
  /** The one-time plaintext agent token. */
  token: string;
}

/**
 * Imperative one-time agent-token reveal: `await TokenRevealDialog.call({ token })`.
 *
 * The plaintext is never stored, so this is the only chance to copy it — surfaced
 * after both node creation and token reset. Render `<TokenRevealDialog />` once high
 * in the tree; `call.ended` drives the controlled `open` so the exit animation plays.
 */
export const TokenRevealDialog = createCallable<TokenRevealProps, void>(
  ({ call, token }) => {
    // Callable components only mount on client-side .call(), so window is safe.
    const dockerCommand = [
      "docker run -d --name blossom-agent",
      "--restart unless-stopped",
      "--network host",
      "--cap-add NET_ADMIN",
      "--device /dev/net/tun",
      `-e AGENT_URL=${window.location.origin}/api`,
      `-e AGENT_TOKEN=${token}`,
      "ghcr.io/keiko233/blossom/server-agent:latest",
    ].join(" ");

    const copy = async (text: string, title: string) => {
      await navigator.clipboard.writeText(text);
      toastManager.add({ type: "success", title });
    };

    return (
      <Dialog
        open={!call.ended}
        onOpenChange={(open) => {
          if (!open && !call.ended) {
            call.end();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.admin_proxies_nodes_token_title()}</DialogTitle>
            <DialogDescription>
              {m.admin_proxies_nodes_token_description()}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/32 p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {token}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label="Copy"
                onClick={() =>
                  void copy(token, m.admin_proxies_nodes_toast_token_copied())
                }
              >
                <CopyIcon />
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {m.admin_proxies_nodes_token_docker_label()}
              </p>
              <div className="flex items-start gap-2 rounded-lg border bg-muted/32 p-3">
                <code className="min-w-0 flex-1 font-mono text-xs break-all">
                  {dockerCommand}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  aria-label="Copy"
                  onClick={() =>
                    void copy(
                      dockerCommand,
                      m.admin_proxies_nodes_toast_command_copied(),
                    )
                  }
                >
                  <CopyIcon />
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button />}>
              {m.admin_proxies_nodes_token_done()}
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
  EXIT_MS,
);
