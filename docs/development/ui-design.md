# UI design standard

Rules for the look, layout and behavior of the admin console in `app/`. Blossom's admin UI is an **operational workstation** for people who watch servers, edit routing and read logs for hours. It should feel like Linear, VS Code, Zed, Termius or the Tailscale admin console: dense, calm, keyboard-friendly, and quiet when nothing is wrong. It should not feel like a generic marketing dashboard.

Style mechanics (`cva()`, `cn()`, `data-slot`, formatting) live in [TypeScript and React style](typescript.md#4-data-slot-attributes-and-ui-styling-cva--cn). Route layout, forms, i18n and server functions live in [App conventions](app.md). This guide owns visual hierarchy, scroll ownership, surfaces, loading states and the anti-slop rules.

Statements are **Established** (the code does this today, checked against the source) unless marked **Recommended** (the standard for new and refactored UI, not yet enforced everywhere). The [desktop UI overhaul spec](../spec/2026-11-26-desktop-ui-overhaul/README.md) is the migration plan that turns the Recommended rules into Established ones; update this guide in the same change that lands each primitive.

## 1. Scroll ownership and viewport model

### Established: today's shell

- `app/src/routes/(admin)/route.tsx` renders `SidebarProvider className="h-dvh"`, so the shell fills the dynamic viewport. `SidebarInset min-h-0` holds `AppShellHeader` (sticky, `h-16`, `h-12` when the sidebar is in icon mode) and then the `admin-viewport` div (`flex min-h-0 flex-1 flex-col overflow-y-auto`, `data-scroll-restoration-id="admin-viewport"`).
- `app/src/components/app-shell/workspace.tsx` provides `Workspace` (from `md`: grid `18rem | minmax(0,1fr)`, one row), `WorkspaceSidebar` (own `overflow-y-auto` from `md`), `WorkspacePane`, `WorkspaceHeader` (`shrink-0 flex-col gap-4`, padding is left to the caller) and `WorkspaceViewport` (from `md`: `flex-1 overflow-y-auto`). Below `md` everything stacks and scrolls with `admin-viewport`.
- Each page renders at most one `WorkspaceViewport`, because the router resets scroll by selector (`WORKSPACE_SCROLL_TO_TOP_SELECTORS`) on new navigations.
- `AdminWorkspaceFrame` (Networking, Access, Operations) wraps its children in a `WorkspaceViewport` and forces every descendant `[data-slot=page-header]` to be sticky through a CSS descendant selector. See [section 4](#4-page-chrome-padding-and-sticky-headers) for why that is a defect.
- The Servers workspace (`routes/(admin)/admin/servers/route.tsx` and `$serverId/route.tsx`) composes the same primitives itself; the Dashboard (`/admin`) renders straight into `admin-viewport`.

### Recommended: the scroll ownership contract

Exactly one element owns vertical scrolling at any point on screen, and everything above it is fixed.

```text
window                      never scrolls                          (h-dvh shell)
└─ SidebarProvider          h-dvh, overflow-hidden
   ├─ AdminSidebar          icon rail, fixed
   └─ SidebarInset          min-h-0 flex-col
      ├─ AppShellHeader     h-12/h-16 sticky, breadcrumb only
      └─ admin-viewport     scrolls ONLY for non-workspace routes and below `md`
         └─ Workspace       md:grid  [18rem sidebar | pane]
            ├─ WorkspaceSidebar   own scroll (a column, not nested)
            └─ WorkspacePane      flex-col min-h-0
               ├─ (optional) WorkspaceTabBar   40-44px, fixed
               └─ ONE of:
                  ├─ WorkspaceViewport   document/table pane: single vertical scroller
                  └─ WorkbenchViewport   workbench pane: overflow-hidden, tool owns scroll
```

Rules:

1. **Never nest vertical scrollers.** A scroller inside another scroller on the same axis is a bug. Sibling columns that each scroll (sidebar, canvas, inspector rail, results pane) are split panes, not nesting, and are allowed.
2. `admin-viewport` must not scroll while a `Workspace` fills it at `md` and up. Add `md:has-[>[data-slot=workspace]]:overflow-hidden` to it so a latent overflow can never produce a second scrollbar.
3. A route renders exactly one pane archetype (below) as the direct content of `WorkspacePane`. In the Servers workspace the tab bar is rendered by the parent route and each tab route renders its own `WorkspaceViewport` or `WorkbenchViewport`.
4. Charts, tables, code blocks and `ScrollArea` popups inside a document pane may scroll horizontally, never vertically (set a `max-h` only on popups such as menus and comboboxes).
5. Do not put fixed heights (`h-[28rem]`, `max-h-72` on page regions) on content. Use `flex-1 min-h-0` and let the pane decide. `max-h-*` is acceptable only inside a popup.
6. Every fixed bar (tab bar, toolbar, status bar) has an explicit height token from the table in section 5 so the canvas can be computed by layout, not by `calc(100vh - …)`.

## 2. Pane archetypes

### A. Document / table pane

Overview, Inbounds, Outbounds, Settings, Users, Plans, Groups, Subscriptions, Redeem, Audit, Traffic, Announcements, MCP, Certificates, Links, Routing.

- Root: `WorkspaceViewport` (single scroller) containing a sticky `PageHeader` (full-bleed) followed by `PageContent` (the only padded element). Details in section 4.
- Tables are the primary content. Prefer a flat, full-width dense table directly on the page background over a table inside a card. **Recommended:** use `Table variant="pane"` (sticky header under the page header and toolbar, `h-9` rows, no inner horizontal scroller). The default `Table` wraps its `<table>` in an `overflow-x-auto` container, which would trap a sticky header, so do not make the header of a default `Table` sticky.
- Do not center content in a narrow column on wide screens unless it is a form. Use the layout recipes below.

### B. Full-bleed workbench pane

Terminal, Logs, Topology (and any future canvas, editor or console).

- Root: `WorkbenchViewport` = `flex min-h-0 flex-1 flex-col overflow-hidden`, **no padding, no outer scrollbar, no `PageHeader`**. The tool owns 100% of the pane height.
- Structure is always `top bar (36-40px) → canvas (flex-1 min-h-0) → status bar (24-28px)`, with an optional side or bottom split pane beside the canvas.
- The canvas scrolls itself (virtualized list, xterm scrollback, React Flow pan/zoom). Size it with `ResizeObserver`, never with a hard-coded height.
- Workbench panes have no `scrollId` because there is nothing to restore; do not add `data-scroll-restoration-id` to them.

### Widescreen layout recipes

Breakpoints: Tailwind defaults (`md` 768, `lg` 1024, `xl` 1280, `2xl` 1536) plus **Recommended** `3xl` at `120rem` (1920) declared in `app/src/styles.css`. The shell consumes a 3rem icon rail and, in workspaces, an 18rem sidebar, so a 1920px screen leaves roughly 1650px for the pane.

| Recipe                     | Use for                                       | Layout                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Dense table + inspector | Users, Subscriptions, Audit, Rule sets, Links | Table fills the pane. From `xl` an optional right inspector (`grid-cols-[minmax(0,1fr)_22rem]`) shows the selected row instead of navigating away or opening a dialog; below `xl` it is a `Sheet`.                        |
| R2 Master-detail           | Server workspace, Groups                      | Persistent left list (`18rem`) + detail pane. Already the shell's `Workspace` grid.                                                                                                                                       |
| R3 Summary grid            | Dashboard, server Overview                    | `grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6` with explicit `col-span-*` per panel. Panels are flat sections separated by borders, not stacked cards.                                                        |
| R4 Form + section nav      | Settings, plan/group/node editors             | Below `xl`: one column, `max-w-3xl`. From `xl`: `grid-cols-[12rem_minmax(0,44rem)]` with a sticky in-page section list on the left. Never leave a 3xl-wide void to the right of a single narrow column without a purpose. |
| R5 Workbench               | Terminal, Logs, Topology                      | Top bar, canvas, status bar; optional split (`xl:grid-cols-[minmax(0,1fr)_22rem]` or a bottom panel).                                                                                                                     |

Below `md` every recipe collapses to one column inside the single `admin-viewport` scroller; workbench panes keep their own bars but stack their side panes as a `Sheet` or bottom panel.

## 3. Surfaces, density and typography

### Established primitives (`app/src/components/ui/`)

- `Card` is `rounded-2xl border bg-card shadow-xs/5` with an inset highlight `before:` pseudo-element. `CardFrame` is a bordered group that visually merges child `Card`s. `Frame` is `rounded-2xl bg-muted/72 p-1` holding `FramePanel`s (`rounded-xl border bg-background p-5`).
- `Toolbar` (Base UI) is styled as `rounded-xl border bg-card p-1`. It is a floating pill, not a bar.
- `Skeleton` is a muted block with a moving sheen (`animate-skeleton`). `Spinner` is `Loader2Icon animate-spin` with `role="status"`.
- `Tabs` has `default` and `underline` variants. `ToggleGroup`, `Group`, `InputGroup`, `Kbd`, `Sheet`, `Popover`, `Menu`, `Select`, `Empty`, `Table`, `ScrollArea` all exist and use `data-slot`.
- Semantic color tokens in `app/src/styles.css` (light and `.dark`): `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `muted-foreground`, `accent`, `destructive`, `border`, `input`, `ring`, the tone triples `success` / `warning` / `info` (+ `-foreground`), `chart-1…5`, `chart-up` / `chart-down`, `code`, and `sidebar-*`. Base radius is `--radius: 0.625rem`. Fonts are Inter (sans, heading) and Geist Mono (mono).

### Recommended: surface rules

1. **One container level per region.** A region is a pane, a section or a card, never two of them nested. Sections inside a document pane are separated by whitespace and a `border-b`, not wrapped in a bordered box.
2. **Use a bordered box only when it groups something that must read as one object**: a standalone summary group, a form that needs a visible save boundary, a dialog or sheet body. Prefer `FramePanel` or `Card` there; both already bring their own radius and shadow.
3. **Radius ladder:** controls and rows `rounded-md`/`rounded-lg`; panels and popups `rounded-xl` (this is the largest radius allowed inside a pane); the existing `Card`/`Frame` `rounded-2xl` is permitted for that primitive only, never as a class you add. `rounded-3xl` and above are banned.
4. **Bars, not pills.** Page headers, tab bars, workbench toolbars and status bars are full-width strips with a `border-b` or `border-t` on `bg-background` (or `bg-muted/30` for status bars). Do not use the pill-shaped `Toolbar` for them; if you reuse the Base UI Toolbar for roving focus, override its surface with `className="rounded-none border-0 border-b bg-background p-0"`.
5. **Shadows:** none on in-pane elements. Popups, dialogs and sheets keep the primitive's shadow.
6. **Density:** table rows `h-9` (36px) in dense tables, `h-10` with an avatar or two-line cell; toolbar controls `size="sm"` (or `xs` in workbench bars); body text `text-sm`; secondary metadata `text-xs text-muted-foreground`. Use `tabular-nums` on every number that changes or aligns in a column (bytes, percentages, counts, timestamps, ports) and `font-mono` for identifiers, addresses, hashes, tags and log text.
7. **Hierarchy comes from weight and color, not size.** Page title `font-heading text-lg font-semibold` (already `PageHeaderTitle`); section title `text-sm font-semibold`; label `text-xs text-muted-foreground`. Never use more than three type sizes in one pane.
8. **Fixed bar heights** (so panes can be reasoned about):

| Bar               | Height                  | Class      |
| ----------------- | ----------------------- | ---------- |
| App shell header  | 48/64px                 | existing   |
| Page header       | 48px                    | `min-h-12` |
| Workspace tab bar | 44px                    | `h-11`     |
| Workbench top bar | 40px (36px in Terminal) | `h-10`     |
| Status bar        | 28px                    | `h-7`      |

## 4. Page chrome, padding and sticky headers

### Established defect: the sticky `PageHeader` side channel

`AdminWorkspaceFrame` passes `[&_[data-slot=page-header]]:sticky … :top-0 … :z-10 … :bg-background` to its viewport, so **every** descendant `PageHeader` becomes sticky regardless of where it sits. Pages then wrap their content in `p-4` or `p-4 md:p-6` and render the header inside that padding. Observed consequences:

1. The header is a child of the padded wrapper, so when stuck it has no horizontal padding of its own. Scrolled content shows through the 16-24px gutters on both sides, and the title is inset from the viewport edge by the wrapper padding instead of aligning with the content column.
2. It has no bottom border or bottom padding, so rows scroll flush against the title and there is no visible edge.
3. Title alignment differs per page (`p-4` on Users and the Dashboard, `p-4 md:p-6` on Rule sets, Topology, Routing and Links, none on Settings which pads inside).
4. Four form pages (plan, group, node, server onboarding) re-declare their own `sticky top-0 z-10/z-20 border-b bg-background/80 backdrop-blur px-4 py-3`, which the frame rule duplicates. The blur and translucent background are glass and banned below.
5. `users/$userId.tsx` renders a `PageHeader` inside a card; the frame rule makes that nested header stick to the top of the viewport and escape its card.
6. The Servers workspace does not use the frame, so its pages' headers (for example Outbounds) are not sticky at all.
7. A CSS descendant selector is an invisible contract: a page cannot opt out, and reading a page's markup does not tell you it is sticky.

### Recommended: explicit page chrome components

Replace the side channel with explicit components in `app/src/components/app-shell/page-header.tsx`:

```tsx
<WorkspaceViewport scrollId=…>            // single scroller, sets --page-header-h: 3rem
  <PageHeader>                            // direct child, sticky, full-bleed
    <PageHeaderTitle />                   // + optional <PageHeaderDescription /> (one line)
    <PageHeaderActions />                 // right-aligned buttons
  </PageHeader>
  <PageToolbar />                         // optional sticky filter row, top-[var(--page-header-h)]
  <PageContent>                           // the ONLY padded element
    …
  </PageContent>
</WorkspaceViewport>
```

| Part            | Contract                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PageHeader`    | `sticky top-0 z-10 flex min-h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 lg:px-6`. Must be a direct child of the viewport (`WorkspaceViewport` or `admin-viewport`). Never inside `PageContent`, a card or a wrapper with padding. Solid `bg-background`; no blur, no alpha. |
| `PageContent`   | `flex flex-col gap-4 p-4 lg:p-6`. Width variants: default (full), `width="form"` (`max-w-3xl`), `flush` (no padding, for edge-to-edge tables). The single source of horizontal alignment: `PageHeader` and `PageContent` use the same `px`.                                                                  |
| `PageToolbar`   | Optional filter/search/bulk-action row. `sticky top-[var(--page-header-h)] z-10 flex h-11 items-center gap-2 border-b bg-background px-4 lg:px-6`. Replaces ad-hoc toolbar cards above tables.                                                                                                               |
| `SectionHeader` | Non-sticky heading row inside a section (`flex items-center justify-between`, `text-sm font-semibold`). Use it anywhere the old code rendered `PageHeader` inside a card or section.                                                                                                                         |

Rules:

- `AdminWorkspaceFrame` stops injecting sticky CSS. It only composes `Workspace` + sidebar + `WorkspacePane` + `WorkspaceViewport`.
- Back-navigation form pages put the back button, title and Save/Cancel actions in `PageHeader`/`PageHeaderActions` (no second sticky bar). A sticky footer is allowed only for a dirty-form action bar and uses `sticky bottom-0 border-t bg-background`.
- Descriptions are one short line or a tooltip, not a paragraph (section 6).
- The Dashboard and any other non-workspace route use the same `PageHeader` as a direct child of `admin-viewport`.

## 5. Loading, empty and error states

### Established

- 45 `<Spinner />` call sites in 39 files under `routes/(admin)` and `components/` (excluding `components/ui/`) fill a pane, card or table body with a centered spinner. `<Skeleton />` is used only in `operations/settings/index.tsx` and the sidebar primitive.
- Several screens load in cascades: the Routing editor shows a spinner for the workspace query, then another for its dependent routing query; the server Overview mounts a live WebSocket, a history query and a traffic query side by side, each with its own spinner or empty box; the Traffic page has four queries with spinners inside KPI cards and charts; the Dashboard replaces the whole page with a centered spinner.

### Recommended: skeleton-first loading

| Situation                                                                    | Use                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First load of a page, pane, table, list, chart, key-value grid or workbench  | **`Skeleton` laid out exactly like the final content** (same row height, column count, chart box and bar heights) so nothing shifts when data arrives. Use the shared skeleton components from `app/src/components/app-shell/skeletons.tsx`. |
| Refetch with data already on screen (`isFetching && !isPending`)             | Keep the old data (`placeholderData: keepPreviousData` where keys change) and show at most a 2px top progress line or a small `Spinner` inside the toolbar's refresh button. Never blank the content.                                        |
| A button's own pending mutation                                              | `Button loading` (which renders the spinner and keeps the width). This is the main legitimate `Spinner`.                                                                                                                                     |
| A streaming or indeterminate connection (WebSocket connecting, reconnecting) | A status dot + text in the pane's status bar or toolbar. No spinner void in the canvas.                                                                                                                                                      |
| Nothing exists yet                                                           | `Empty` with one sentence and one primary action.                                                                                                                                                                                            |
| The request failed                                                           | An inline `Alert` or `Empty` with the retry button, in the same footprint as the skeleton.                                                                                                                                                   |

`Spinner` is **never** the only child of a page, pane, card, table body or dialog body.

Shared skeletons (specified in the overhaul spec): `TableSkeleton`, `SidebarListSkeleton`, `KeyValueGridSkeleton`, `ChartSkeleton`, `StatStripSkeleton`, `FormSkeleton`, `WorkbenchSkeleton`, `InspectorSkeleton`. Each takes counts, never free-form content, and renders `aria-busy="true"` with a single `sr-only` loading label.

### Query coordination

1. **One gate per region, not per widget.** A region (summary grid, table body, chart row) decides `pending` once from the queries it needs and renders one skeleton for the whole region. Do not give each child its own spinner.
2. **Start independent queries together.** Use sibling `useQuery` calls in the region's parent (they already run in parallel) or `useQueries`; never gate query B behind query A's render unless B needs A's result.
3. **Dependent queries share the skeleton.** When B truly depends on A (Routing editor: workspace → selected server's routing), render the same skeleton for both phases so the screen does not flash skeleton → empty → skeleton. The picker and header render from A as soon as it resolves; only the region that needs B stays a skeleton.
4. **Critical identity data belongs in the route `loader`** (for example `getServer`), so the shell never renders without it. Everything else is client-queried behind a skeleton.
5. **Secondary data never blocks primary data.** A failed history chart must not hide the server's identity grid; each region has its own error state.
6. **Polling queries** (`refetchInterval`) keep previous data and never return to the skeleton.

## 6. The anti-"AI slop" ban list

These patterns make an operational tool look generic and waste screen space. They are review blockers.

| Instead of                                                                                                                                                                   | Do this                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A card wrapping a card, or a card wrapping a table that already has borders (`rounded-xl border bg-card p-4 shadow-xs` 32 occurrences in `routes/(admin)` and `components/`) | One container level. A section is a heading row plus content on the page background, separated by `border-b`.                                                               |
| `rounded-2xl`/`rounded-3xl` classes on panels, chips or inputs                                                                                                               | `rounded-lg` for rows and controls, `rounded-xl` at most for popups and panels.                                                                                             |
| Wrapping every toolbar, filter row or tab strip in a bordered `bg-card` box                                                                                                  | A full-width strip: `border-b bg-background`, 36-44px high, controls inline.                                                                                                |
| `bg-gradient-*`, gradient text, purple/indigo/violet accents, neon glows, `blur-3xl` blobs, `shadow-[0_0_*]` glows                                                           | Flat semantic tokens. Color means state: `success`, `warning`, `info`, `destructive`. The neutral `primary` is the only accent.                                             |
| `backdrop-blur` and translucent `bg-background/80` sticky headers (five sticky bars in four admin form pages today)                                                          | Solid `bg-background` with a `border-b`.                                                                                                                                    |
| A hero banner, welcome message ("Welcome back!"), decorative illustration or marketing tagline on an admin page                                                              | The page header title and its actions. The first thing on screen is data.                                                                                                   |
| A paragraph of explanation above every table, form or tool                                                                                                                   | Nothing, or one line (`PageHeaderDescription`), or an info icon with a `Tooltip`/`Popover` for the long version.                                                            |
| ALL-CAPS tracked eyebrow labels above titles and sections (`uppercase tracking-wider text-xs`)                                                                               | Sentence-case `text-xs text-muted-foreground` labels, or no label.                                                                                                          |
| Vanity KPI cards (big number, tiny caption, an icon, a trend arrow) in a row of equal tiles                                                                                  | A single compact stat strip: one bordered row of label/value pairs with dividers, or the table the number summarizes. Show a number only if an operator acts on it.         |
| Emoji as icons or decoration, or icons next to every heading                                                                                                                 | `lucide-react` icons only where they aid scanning (status, actions, nav). Never in headings by default.                                                                     |
| `hover:scale-*`, `hover:-translate-y-*`, bouncy springs, entrance animations on rows or buttons                                                                              | `transition-colors` (≤150ms) on hover and focus. Motion only for open/close of popups and `animate-skeleton`. Respect `prefers-reduced-motion`.                             |
| A centered `<Spinner />` as the whole page, pane or table body                                                                                                               | A layout-matched `Skeleton` and coordinated queries (section 5).                                                                                                            |
| A fixed-height scrollbox inside a scrolling page (`h-[28rem] overflow-auto` inside the page scroller) or two scrollbars next to each other                                   | One scroller per region (section 1). A workbench pane for tools that need their own scroll.                                                                                 |
| Centering a `max-w-3xl` column on a 2560px screen                                                                                                                            | A layout recipe from section 2 that uses the width: table, split pane, summary grid or form + section nav.                                                                  |
| `<Badge>` pile on every row (phase, health, kind, status…)                                                                                                                   | A status dot + one short label; put the rest in the inspector or a column that can be sorted.                                                                               |
| Ad-hoc colors (`text-emerald-600`, `bg-[#0b0f14]`, `bg-red-500` dots)                                                                                                        | Tokens (`text-success-foreground`, `bg-success`, `--terminal-bg`). The one existing exception, `statusDotClass` in `server-status.tsx`, should move to tokens when touched. |

When in doubt, remove a box, a sentence or a decoration, not add one.

## 7. Coss UI and Base UI composition rules

Blossom's primitives follow [Coss UI](https://coss.com/ui) (the `@coss` registry in `app/components.json`) on `@base-ui/react`, with Tailwind CSS v4. Established where it names code; the rest is Recommended.

1. **Compose from `components/ui/*`.** Never import `@base-ui/react/*` parts into a feature file; add or extend the primitive. (Established boundary in [TypeScript and React style](typescript.md#4-data-slot-attributes-and-ui-styling-cva--cn).)
2. **`render` replaces Radix `asChild`.** To make a primitive render another element, pass `render={<Link … />}` (`MenuTrigger render={<Button size="sm" />}`, `Button render={<Link to="…" />}`). Never add `asChild`. For your own polymorphic components, use `useRender` + `mergeProps` the way `Card` does.
3. **`data-slot` on every reusable root and structural part**, lowercase kebab-case, and forward `data-*` props. Slots are the styling and test hooks (`workspace-viewport`, `server-tab-bar`, `terminal-session-bar`, `topology-server-node`). Do not add wrapper `div`s only for a slot.
4. **`cva()` for variants, `cn()` for merging, grouped classes.** No `*_CLASS` constants. Long class lists split by responsibility (layout → surface → interaction).
5. **Tokens only.** Colors, borders and rings come from the semantic tokens; new tokens (for example `--terminal-bg`, `--topology-edge-*`) are added to `app/src/styles.css` for both light and `.dark` and mapped in `@theme inline`, never hard-coded in a component. Third-party widgets (React Flow, xterm) are themed through those tokens.
6. **Group related controls.** Use `Group` for button clusters (font size `−` `+`), `InputGroup` for an input with an icon, addon or shortcut hint, `ToggleGroup` for 2-4 mutually exclusive view modes (Graph | List), and `Tabs` (`variant="underline"`) for switching panels within a pane. Route-level tabs are real `Link`s with `aria-current`, not `Tabs`.
7. **Pick the overlay by task size.** `Tooltip` for names and shortcuts of icon buttons; `Popover` for one small form or option group; `Menu` for action lists; `Sheet` for a form or inspector that needs ~20-30rem and must not block the tool; `Dialog` for a short blocking decision; `Confirm.call` for destructive or safety-gated actions (it stays mandatory for opening a terminal).
8. **Empty states** use `Empty` (`EmptyHeader` / `EmptyTitle` / `EmptyDescription` / `EmptyContent`): one icon at most, one sentence, one primary action. In a canvas or table they are compact and centered in that region.
9. **Every icon-only button has `aria-label` and a `Tooltip`**, and shows its shortcut with `Kbd`/`KbdGroup` when it has one.
10. **Focus is always visible.** Controls inherit the primitive ring (`focus-visible:ring-2 ring-ring ring-offset-1`); hand-built rows and links inside panes use `focus-visible:ring-[3px] focus-visible:ring-ring/24` (the repo's existing pattern). Do not invent a third style and never remove the outline without a replacement.
11. **Numbers and time.** `tabular-nums` for changing numerals; format bytes, dates and durations through `@/lib/format`; show UTC explicitly where the data is UTC (logs).
12. **Disabled and pending.** Disable submit and close while a mutation runs and guard with `useLockFn` ([App conventions](app.md#data-fetching-and-mutations)). Prefer `Button loading` over swapping the label for a spinner.

## 8. Keyboard and accessibility

- Everything reachable by mouse is reachable by keyboard in a logical Tab order: tab bar, toolbar, canvas/list, status bar. Roving `tabindex` for lists and tab strips; arrow keys move, Enter activates.
- Canvases need an accessible equivalent: the topology has a list view; the log viewer is a `listbox` with `aria-activedescendant`; the terminal announces connection state with `role="status"`.
- Status is never color alone: pair every dot with text or an `aria-label`/`title`.
- Workbench shortcuts are single keys active only when the canvas has focus (`F` follow, `/` search, `Esc` clear) plus `Ctrl/Cmd+F` for search where the pane owns it. List every shortcut in the status bar or a tooltip.
- Live regions: `role="status"` for connection state changes; `role="alert"` for failures. Do not announce every log line or metric sample.
- Honor `prefers-reduced-motion` for the animated edge dash and skeleton sheen.

## 9. i18n and tests for UI work

- All visible strings go through Paraglide with keys added to `en.json` and `zh-cn.json` in the same logical position ([App conventions](app.md#internationalisation)). Prefix keys by area. When several people add keys in parallel, insert each block after its own existing anchor key so merges stay clean.
- Vitest runs `.test.ts` files in Node and there are no DOM tests ([Testing and verification](testing.md#app-vitest)). Put layout math, view-model derivation, reducers, status mapping and codecs in plain modules under `app/src/lib/` and test them there. Verify component structure with `tsc --noEmit`, `pnpm fmt`, `pnpm lint`, a build for the affected deploy targets, and a manual pass at 1280, 1920 and 2560px in light and dark.

## 10. Review checklist

1. Which pane archetype is this, and is there exactly one scroller per region?
2. No nested boxes, no `rounded-2xl+` classes you added, no blur, gradient, glow, emoji or all-caps eyebrow labels.
3. First load is a layout-matched skeleton; no `Spinner` outside a button or toolbar refresh indicator.
4. `PageHeader` is a direct child of the viewport; `PageContent` is the only padded element; alignment matches other pages.
5. Widescreen: the page uses one of the R1-R5 recipes at `xl`/`2xl`/`3xl`.
6. Tokens only; both themes checked; third-party widgets themed through tokens.
7. Icon buttons have names, tooltips and focus rings; status is not color-only; shortcuts are listed.
8. New strings exist in both locales; new logic has a `lib/` unit test; the checks from [Testing and verification](testing.md#commands) that fit the change ran, and anything not run is stated.
