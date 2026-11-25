# 04 Terminal workbench (worker B, Wave 2)

Goal: the Terminal tab becomes a full-bleed fixed workbench in the style of Termius, Warp and the VS Code terminal: slim session bar, a terminal canvas that fills the pane, a slim status bar. No card, no title block, no notice boxes, no fixed height, no outer scrollbar. Requires W1 merged.

## Files

Create:

- `app/src/routes/(admin)/admin/servers/_modules/terminal-session-bar.tsx`
- `servers/_modules/terminal-status-bar.tsx`
- `servers/_modules/terminal-empty-state.tsx`
- `app/src/lib/terminal-view.ts` + `terminal-view.test.ts`

Modify:

- `servers/$serverId/terminal.tsx` (root becomes the workbench)
- `servers/_modules/agent-terminal-panel.tsx` (layout and state surface only; protocol logic untouched)
- `app/src/components/terminal/xterm-terminal.tsx`
- i18n: prefixes `agent_terminal_bar_`, `agent_terminal_status_`, `agent_terminal_empty_`, `agent_terminal_font_`, inserted after `agent_terminal_reason_shell_exit` in both locales. Reuse existing `agent_terminal_*` keys wherever they still apply; remove nothing that other code uses.

Do not touch: `lib/pty-protocol.ts`, the `/api/admin/servers/$id/pty/*` routes, `Confirm`.

## Safety behavior that must be preserved exactly

1. `open()` still calls `Confirm.call({ title, description, confirmLabel: connect, cancelLabel })` first and returns if not confirmed.
2. Then `probeTerminal(server.id)` (`/pty/status`, `cache: "no-store"`, 403 → denied) runs **before** any WebSocket is created; non-ready probes set `phase = "error"` and the notice.
3. Session id `pty-<uuid>`, query params `sessionId/cols/rows`, the `PTY_OPEN_TIMEOUT_MS` start timer, backpressure close (`MAX_BROWSER_BACKLOG`), `finishedRef/startedRef` logic, unmount/server-switch teardown closing with `view_closed`, and "connected only after `pty.started`" all stay as they are. Do not move them into a new hook unless the move is mechanical and the unit behavior is identical (a mechanical extraction to `use-agent-terminal.ts` is allowed but not required).
4. No credentials, session inputs or terminal output are persisted (the font size is the only stored preference).

## Layout

`terminal.tsx`:

```tsx
function RouteComponent(): React.ReactElement {
  const server = useWorkspaceServer();
  return (
    <WorkbenchViewport data-slot="terminal-workbench">
      <AgentTerminalPanel server={server} />
    </WorkbenchViewport>
  );
}
```

`AgentTerminalPanel` root: `data-slot="agent-terminal-panel"` `className="flex min-h-0 flex-1 flex-col overflow-hidden"`:

```text
┌ terminal-session-bar (WorkbenchBar, h-10) ──────────────────────────────────────────────────┐
│ ● Connected   keiko@host — /bin/bash                     [Disconnect] [⌫] [A− A+] [⤢ Refit]  │
├ terminal-canvas (flex-1 min-h-0, bg-terminal) ───────────────────────────────────────────────┤
│  xterm fills 100% (ResizeObserver → fit)  |  or centered empty/idle/unavailable state         │
├ terminal-status-bar  (WorkbenchStatusBar, h-7, font-mono text-xs) ───────────────────────────┤
│ wss · pty            120×32                                        Session ended (exit 0)    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Session bar (`TerminalSessionBar`, `data-slot="terminal-session-bar"`)

Built on `WorkbenchBar` (default `h-10`, 40px, the same as Logs).

- Left: `StatusDot` (`connected→success`, `connecting→info+pulse`, `error→danger`, `closed|idle→muted`) + phase text (`m.agent_terminal_status_*`, `text-xs font-medium`) inside a `role="status"` span; when `phase === "connected"` and an identity exists, a `font-mono text-xs text-muted-foreground truncate` span with `m.agent_terminal_identity({ user, shell })` formatted as `user@host — shell` (build the string with `formatTerminalIdentity(user, shell, host)` from `lib/terminal-view.ts`; the host is `server.address`). Keep `data-slot="terminal-identity"`.
- Right (`ms-auto flex items-center gap-1`):
  - Connect / Disconnect: `Button size="xs"`; Connect is the primary variant with `loading={opening}` and `disabled={Boolean(unavailable) || opening}`; Disconnect is `variant="outline"` with the `UnplugIcon`. Same conditions as today (`terminalMounted && (connected || connecting)` shows Disconnect).
  - Clear (`EraserIcon`, `size="icon-xs"`, `aria-label` + `Tooltip`), disabled until `terminalMounted`.
  - Font size: a `Group` of two `Button size="icon-xs"` (`−`, `+`) with a `tabular-nums` readout between them (`13`); disabled until `terminalMounted`; clamp 10-24 via `clampTerminalFontSize`. Shortcuts `Ctrl/Cmd +` / `−` are **not** bound (they collide with browser zoom); show only tooltips.
  - Refit (`Maximize2Icon`, `size="icon-xs"`, `aria-label` "Refit terminal"): calls `terminalRef.current?.fit()`.
- Controls collapse to icon-only below `lg` (hide text labels with `max-lg:sr-only`).

### Canvas (`data-slot="terminal-canvas"`)

`relative min-h-0 flex-1 overflow-hidden bg-terminal`. Children:

- `XtermTerminal` (when `terminalMounted`) as `absolute inset-0`. Remove the component's defaults `min-h-72 rounded-lg p-2`; it now renders `size-full overflow-hidden bg-terminal px-2 py-1` (the padding is inside the same-colored surface so `FitAddon` measures the padded box correctly). Its existing `ResizeObserver` → `scheduleFit` stays; additionally observe the parent pane via the same observer so a sidebar collapse or window resize refits. **Remove `className="h-[28rem]"`** from the panel.
- `TerminalEmptyState` (`data-slot="terminal-empty-state"`) as `absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center`, shown when `!terminalMounted`, or when `phase` is `error`/`closed` and a notice exists. It uses terminal tokens (`text-[color:var(--terminal-foreground)]`), no card, no border:
  - idle & available: `SquareTerminalIcon` (size-8, muted), one line `m.agent_terminal_empty_idle()`, one primary `Button` Connect (same handler `open()`; keeps the confirm gate), and `m.agent_terminal_opt_in_note()` as a single `text-xs` line.
  - unavailable (`disabled|offline|unsupported`): same layout with the `unavailableMessage(...)` text and the Connect button disabled.
  - error/closed after a session: the notice text (`role="alert"` for errors) and a "Reconnect" Connect button. The old `terminal-notice` paragraph above the terminal is deleted; the notice also goes to the status bar.
    When a session ended but scrollback should stay readable, keep the terminal mounted and overlay nothing; show the notice only in the status bar (Reconnect lives in the session bar's Connect button).

### Status bar (`TerminalStatusBar`, `data-slot="terminal-status-bar"`)

`WorkbenchStatusBar`. Left: transport (`wss · pty` when the page is https, `ws · pty` otherwise: derive from `window.location.protocol` in an effect-free helper `terminalTransportLabel(protocol)`), then `cols×rows` (`formatTerminalSize(cols, rows)`, `tabular-nums`, updated from the `onResize` callback; show `—` when no terminal). Right (`ms-auto min-w-0 truncate`, `title` = full text): the latest notice (exit reason, error, disconnected) with a `StatusDot` tone from the phase. The bar never wraps and never changes height.

### `XtermTerminal` changes

- Props added: `fontSize?: number` (default 13), `onSize?(cols, rows)`. Changing `fontSize` sets `terminal.options.fontSize` and schedules a fit.
- Handle added: `refit()` is the existing `fit()`; add `getSize(): { cols: number; rows: number } | null`.
- Theme: read `--terminal-*` custom properties (declared by W1) once at construction with `getComputedStyle(document.documentElement)` and map them into xterm's `theme`; fall back to the current literals if a property is empty. The terminal is a dark surface in both app themes.
- Keep: dynamic imports of xterm and its CSS inside the effect (SSR/Workers safety), `WebLinksAddon` with `noopener,noreferrer`, `cursorBlink`, `scrollback: 5000`, `allowProposedApi: false`.

### Font size preference

`lib/terminal-view.ts` exports `TERMINAL_FONT_SIZE = { min: 10, max: 24, default: 13 }`, `clampTerminalFontSize(n)`, `readTerminalFontSize(storage)`, `writeTerminalFontSize(storage, n)` using key `blossom.terminal.font-size.v1`. Storage access is wrapped in `try/catch` (private windows, blocked storage); the component passes `window.localStorage` inside an effect and renders the default on the server.

## `lib/terminal-view.ts` (pure) and tests

```ts
export type TerminalPhase = "idle" | "connecting" | "connected" | "closed" | "error";
export function terminalPhaseTone(phase: TerminalPhase): "success" | "info" | "danger" | "muted";
export function terminalPhasePulse(phase: TerminalPhase): boolean;
export function formatTerminalIdentity(user: string, shell: string, host: string): string; // "user@host — shell"
export function formatTerminalSize(cols: number | null, rows: number | null): string;      // "120×32" | "—"
export function terminalTransportLabel(protocol: string): string;                          // "wss · pty" | "ws · pty"
export const TERMINAL_FONT_SIZE, clampTerminalFontSize, readTerminalFontSize, writeTerminalFontSize
```

`terminal-view.test.ts`: phase → tone/pulse for all five phases; identity with empty user/shell/host fallbacks; size formatting including `null`; transport label for `https:`/`http:`; clamp edges and non-integers/NaN; storage read/write with a fake `Storage` that throws and one that returns garbage. Move `TerminalPhase` to this module and import it in the panel.

## Accessibility and keyboard

- The session bar is a `role="toolbar"` with `aria-label`; buttons are in Tab order; the xterm canvas receives focus on connect (existing `terminal.focus()`), and `Esc` is **not** intercepted (the shell needs it).
- Phase changes announce through the `role="status"` span; the notice announces as `role="status"` (info) or `role="alert"` (error).

## Verification

```bash
pnpm --filter @blossom/app exec vitest run src/lib/terminal-view.test.ts
pnpm --filter @blossom/app exec tsc --noEmit
pnpm fmt && pnpm lint && pnpm test
pnpm build
```

Manual QA (preview tools; connect to a disposable local server with an agent that supports `pty-v1`/`pty-v2`, or verify idle/unavailable/error states by mocking `/pty/status`):

- Pane shows no outer scrollbar or padding at 1280, 1920, 2560 and 390 px; the canvas fills the space between the bars.
- Click Connect → the confirm dialog appears before any network call; cancelling does nothing; confirming runs the probe, then the socket; the bar shows Connecting then Connected with `user@host — shell`.
- Resize the window and collapse the server list: `cols×rows` in the status bar updates and the shell receives `pty.resize`.
- Font `+`/`−` changes size and refits; the value survives a reload; blocked `localStorage` still works with the default.
- Disconnect, error and unavailable states render the centered empty state with exactly one CTA; leaving the tab or switching servers closes the socket.
