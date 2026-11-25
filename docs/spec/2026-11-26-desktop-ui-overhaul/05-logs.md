# 05 Logs workbench (worker C, Wave 2)

Goal: the Logs tab becomes a full-bleed workbench in the style of the VS Code Output panel and Zed's log views: a slim toolbar, a virtualized monospace canvas that fills the pane, a retained-search results panel that shares the viewport, and a status bar. The 576-line inline log-policy card becomes a right `Sheet`. Requires W1 merged.

## Files

Create (all under `app/src/routes/(admin)/admin/servers/_modules/`):

- `logs-toolbar.tsx`, `logs-search-bar.tsx`, `log-search-results.tsx`, `logs-status-bar.tsx`, `server-log-policy-sheet.tsx`
- `app/src/lib/log-view-format.ts` + `log-view-format.test.ts` (column formatting and level styling helpers)

Modify:

- `servers/$serverId/logs.tsx` (root becomes the workbench)
- `_modules/server-logs-panel.tsx` (composition, state, layout)
- `_modules/log-viewer.tsx` (full-height canvas, fixed columns)
- `_modules/server-log-policy-panel.tsx` (becomes the Sheet body: flat sections, no card in card)
- `_modules/log-context-dialog.tsx` (spinner → skeleton rows)
- `_modules/log-line-text.tsx` (only if column wrapping needs it)
- `app/src/lib/admin-logs-view.ts` (+ `admin-logs-view.test.ts`) only for new pure helpers
- i18n: prefixes `agent_logs_toolbar_`, `agent_logs_search_bar_`, `agent_logs_results_`, `agent_logs_status_bar_`, `agent_logs_policy_sheet_`, inserted after `agent_logs_level_trace` in both locales. Reuse the 136 existing `agent_logs_*` keys wherever they still fit.

Do not change `use-server-logs.ts`, `use-server-log-policy.ts`, `lib/admin-logs-route.ts`, the `/logs/ws` protocol, audit rows, or any query. Query text and records stay in component state only (nothing in the URL or storage), as the current doc comment promises.

## Layout

`logs.tsx` renders `<WorkbenchViewport data-slot="logs-workbench"><ServerLogsPanel server={server} /></WorkbenchViewport>`.

`ServerLogsPanel` root `data-slot="server-logs-panel"` `className="flex min-h-0 flex-1 flex-col overflow-hidden"`:

```text
┌ logs-toolbar (WorkbenchBar h-10) ────────────────────────────────────────────────────────────────┐
│ [▶ Follow] [Source: All ▾] [Level: info+ ▾] [🔍]            [Policy ●] [Copy (3)] [✕ Clear sel.] │
├ logs-search-bar (h-9, only while open) ──────────────────────────────────────────────────────────┤
│ 🔍 [ query ............................ ] [UTC range ▾] [Search] [✕]                              │
├ workbench-body ──────────────────────────────────────────────────────────────────────────────────┤
│ ┌ log canvas (flex-1 min-h-0) ───────────────────────────┐ ┌ results (xl: right 28rem · below: ─┐ │
│ │ ☐ 12:04:05.123 ERROR sing-box  inbound/vless: …        │ │ bottom, max 40%)                    │ │
│ │ ☐ 12:04:05.130 INFO  agent     applied revision 41     │ │ 12:01:44.002 WARN … (virtualized)   │ │
│ └────────────────────────────────────────────────────────┘ └─────────────────────────────────────┘ │
├ logs-status-bar (WorkbenchStatusBar h-7) ────────────────────────────────────────────────────────┤
│ ● Live  ·  1,240 lines  ·  +310 trimmed  ·  ↑↓ move · Space select · Enter context · F follow     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

There is exactly one outer scroller: none. The log canvas scrolls itself (`overflow-auto`, one scroller), the results panel scrolls itself; they are siblings in a split, never nested. Delete every dashed notice box, the description paragraph and the card wrapper from the old panel.

### Toolbar (`LogsToolbar`, `data-slot="logs-toolbar"`)

`WorkbenchBar` containing, left to right (all `size="sm"`/`xs`, `h-7` controls):

1. **Follow/Pause**: `Toggle` (Base UI) `pressed={controller.following}` with `PlayIcon`/`PauseIcon` and text `m.agent_logs_action_resume()` / `m.agent_logs_action_pause()` shown from `lg`; disabled under the same conditions as today (`!available || !availability.tail || phase in {unauthorized, unavailable, unsupported}`). `aria-keyshortcuts="F"`; `Tooltip` shows `Kbd` `F`.
2. **Source** `Select` (`all | agent | sing-box`, `SelectTrigger size="sm" className="w-28"`), **Min level** `Select` (`trace…error`, `w-24`). Labels are `aria-label`s (`m.agent_logs_filter_source`, `m.agent_logs_filter_level`), not visible text above the control. Behavior and handlers (`updateSource`, `updateLevel`) are unchanged.
3. **Search toggle**: `Button variant="ghost" size="icon-xs"` (`SearchIcon`), `aria-pressed` while the search bar is open, `aria-keyshortcuts="Control+F Meta+F"`. Opening focuses the search input. Disabled with a tooltip when search is unsupported by the agent.
4. Spacer, then right cluster: **Log policy** button (`SlidersHorizontalIcon` + `m.agent_logs_policy_title()` from `xl`) opening `ServerLogPolicySheet`; it shows a `StatusDot` when the policy view has pending/applying/error cues (from `logPolicyCues`); **Copy selected (N)** (`CopyIcon`, `loading={copying}`, disabled at N = 0); **Clear selection** (`XIcon`, only when N > 0).

Keyboard (scoped to the workbench, ignored while typing in an input except where noted): `Ctrl/Cmd+F` opens the search bar and focuses it (`preventDefault` only inside the logs workbench so browser find still works elsewhere), `Esc` in the search input closes the bar and calls `clearSearch`, `/` focuses the search input when the canvas is focused. `F`, `↑ ↓ PageUp PageDown Home End`, `Space`, `Enter` stay in `LogViewer`.

### Search bar (`LogsSearchBar`, `data-slot="logs-search-bar"`)

Rendered only while open; `h-9 border-b bg-background px-2` row containing a `form`: `InputGroup` (search icon + `Input` for the query + a `Kbd` hint), a **UTC range** `Popover` (trigger shows `m.agent_logs_search_range()` and a dot when a range is set; popup holds the two existing `datetime-local` fields interpreted as UTC with the `toUtcIso` validation and the `rangeInvalid` message), `Button type="submit" size="xs"`, close `Button size="icon-xs"`. Reuse the existing `submitSearch`/`clearSearch` handlers and state. A coverage note (`searchableRange`) is a `text-xs` tooltip on the results header, not a paragraph.

### Results panel (`LogSearchResults`, `data-slot="log-search-results"`)

Shown when `controller.search.status !== "idle"` (retained search active). It is a **sibling** of the log canvas inside `workbench-body`:

- From `xl`: `WorkbenchBody` is a row; results are a right pane `w-112 shrink-0 border-s` (28rem) with a `min-h-0 flex-col` layout.
- Below `xl`: `WorkbenchBody` is a column; results are a bottom panel `h-[min(40%,18rem)] shrink-0 border-t`.
- Header row (`h-8 border-b px-3`, `text-xs`): result count (`tabular-nums`), coverage tooltip, "Load more" when `hasOlder` (`controller.searchMore`), close button (`controller.cancelSearch`). Body: a **virtualized** list (`@tanstack/react-virtual`, same technique as `LogViewer`, row height 26px) whose rows are the existing `SearchResultRow` content (`time.slice(11, 23)`, level, source, `LogLineText` with highlight). Selecting a row calls `controller.openContext(record, generation)` which opens `LogContextDialog` (unchanged dialog behavior). `searching` state: `TableSkeleton`-style rows (`rows={6}`), never a spinner; empty complete result: compact `Empty`; errors inline with `role="alert"`.
- This replaces the old inner `max-h-72 overflow-y-auto` list.

### Log canvas (`LogViewer`)

- Remove `h-[28rem]` and the rounded border: root `h-full min-h-0 flex-1 overflow-auto bg-background font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:ring-inset`. Keep the virtualizer, `ROW_HEIGHT = 26`, `aria-activedescendant`, the listbox roles, auto-follow, scroll-up-pauses-follow and every key handler exactly as they are.
- **Fixed-width columns** (a CSS grid per row: `grid-cols-[1.25rem_8.5rem_3.75rem_5.5rem_minmax(0,1fr)_auto] items-center gap-2 px-2`): checkbox gutter; timestamp `HH:MM:SS.mmm` (`tabular-nums`, `text-muted-foreground`); level tag; source tag; message (`whitespace-pre`, the row keeps `w-max min-w-full` so long lines scroll horizontally); truncation marker (`m.agent_logs_truncated()`).
- **Level tag**: a fixed-width uppercase 5-char label (`TRACE DEBUG INFO  WARN  ERROR`) colored by token via `cva` in `lib/log-view-format.ts` (`trace|debug → text-muted-foreground`, `info → text-info-foreground`, `warn → text-warning-foreground`, `error → text-destructive-foreground`); never color alone: the text is always shown. Gap rows (`restarted/overwritten/dropped`) span all columns with `bg-warning/8 text-warning-foreground`.
- Selection checkbox visual unchanged (the small bordered box with `CheckIcon`).
- Empty tail (`tailEmpty`) shows a compact centered `Empty` inside the canvas; `connecting`/`reconnecting` with no entries shows `TableSkeleton`-style monospace rows (18 rows), not a spinner.
- Unavailable states (`disabled`, `offline`, `unsupported`, `unauthorized`, `unavailable`, `error`): one compact centered `Empty` in the canvas region with the existing message and no other chrome; the toolbar controls are disabled. The status bar still shows the phase.

### Status bar (`LogsStatusBar`, `data-slot="logs-status-bar"`)

`WorkbenchStatusBar`: `StatusDot` + phase text (`phaseBadge`'s labels, but plain text), buffered line count (`tail.entries` length, `tabular-nums`), `+N trimmed` when `tail.trimmed > 0` (tooltip: older lines were dropped from the in-memory window), selected count when > 0, and at the right (`ms-auto`, hidden below `xl`) the shortcut legend `↑↓ move · Space select · Enter context · F follow` built from `KbdGroup`. The `tailError` text, when present, shows in the status bar in `text-destructive-foreground` with `role="alert"`.

### Policy sheet (`ServerLogPolicySheet`)

`Sheet` (right side, `sm:max-w-md`) opened from the toolbar; `SheetHeader` title `m.agent_logs_policy_title()`, `SheetPanel` containing the per-source sections from `server-log-policy-panel.tsx`. Convert each `article rounded-lg border bg-muted/20 p-3` into a flat `section` separated by `border-b py-4` with a `SectionHeader`; keep `logPolicyCues` badges, baseline/temporary controls, the conflict handling and every handler from `use-server-log-policy.ts` unchanged. Replace the inline `Spinner` with `Button loading` on the save/reset buttons and `FormSkeleton fields={4}` while the policy query is pending. The query may stay always enabled so the toolbar dot works (`staleTime` 15 s); do not poll.

## `lib/log-view-format.ts` and tests

```ts
export const LOG_COLUMNS = "grid-cols-[1.25rem_8.5rem_3.75rem_5.5rem_minmax(0,1fr)_auto]"; // documented constant, used via cva
export function formatLogTime(iso: string): string;      // "HH:MM:SS.mmm" from the ISO string, UTC
export function padLevel(level: string): string;          // fixed 5-char label, uppercase
export const logLevelVariants: ...;                       // cva: trace|debug|info|warn|error
export function resultsPlacement(width: number): "right" | "bottom";   // >= 1280 -> right
```

(`LOG_COLUMNS` may live inside the `cva`/component instead of being exported if that reads better; do not create a `*_CLASS` constant.) Tests: `formatLogTime` for valid, short and malformed timestamps (never throws); `padLevel` all levels and unknown input; `logLevelVariants` returns the documented token class per level; `resultsPlacement` at 1279/1280.

## Verification

```bash
pnpm --filter @blossom/app exec vitest run src/lib/log-view-format.test.ts src/lib/admin-logs-view.test.ts
pnpm --filter @blossom/app exec tsc --noEmit
pnpm fmt && pnpm lint && pnpm test
pnpm build
```

Manual QA (preview tools with a live agent, or a stubbed `/logs/ws`): no outer scrollbar at 1280/1920/2560/390 px; the canvas fills the pane; scrolling up pauses follow and `F` resumes; `Ctrl/Cmd+F` opens the search bar; running a search shows the right pane at ≥ 1280 and the bottom panel below; clicking a result opens the context dialog; the policy Sheet opens, saves and reflects pending/applying cues on the toolbar dot; copy selected copies the formatted lines; level colors are readable in both themes; audit rows still appear for subscribe/search/context.
