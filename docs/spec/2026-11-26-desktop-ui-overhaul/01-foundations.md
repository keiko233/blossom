# 01 Foundations (worker W1, Wave 1)

Lands first. Every Wave 2 worker imports what this workstream creates, so keep the exported names and `data-slot` values below exactly as written. Read [UI design standard](../../development/ui-design.md) sections 1-5 first.

## Files

Create:

- `app/src/components/app-shell/skeletons.tsx`
- `app/src/components/ui/status-dot.tsx`

Modify:

- `app/src/components/app-shell/workspace.tsx`
- `app/src/components/app-shell/page-header.tsx`
- `app/src/components/ui/table.tsx` (add the `pane` variant, below)
- `app/src/routes/(admin)/_modules/admin-workspace-frame.tsx`
- `app/src/routes/(admin)/route.tsx` (only the `admin-viewport` class)
- `app/src/styles.css`
- `app/package.json`, `pnpm-lock.yaml` (add `@xyflow/react`)
- `docs/development/app.md` (the "UI composition" bullets about `PageHeader`/`Spinner`/workspace primitives; link to `ui-design.md`)
- `app/messages/en.json`, `app/messages/zh-cn.json`: prefix `admin_ui_`, inserted after `admin_workspace_access_client_rules`

Do not migrate any route; do not change callers of `PageHeader` (worker F and the feature workers do that).

## Workspace primitives (`workspace.tsx`)

Keep `Workspace`, `WorkspaceSidebar`, `WorkspacePane`, `ADMIN_VIEWPORT_SCROLL_ID`, `WORKSPACE_SCROLL_TO_TOP_SELECTORS` unchanged. Change or add:

| Export               | `data-slot`            | Classes (exact)                                                                                                       | Notes                                                                                                                                                                                        |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceHeader`    | `workspace-header`     | `shrink-0 border-b bg-background`                                                                                     | No gap or padding opinion any more (callers put their own bar inside). Currently only the server route uses it; worker A stops using it. Keep it exported for compatibility.                 |
| `WorkspaceTabBar`    | `workspace-tab-bar`    | `flex h-11 shrink-0 items-stretch gap-1 border-b bg-background px-2`                                                  | A `div`; children are a scrollable `nav` and an `ms-auto` actions cluster. Accepts `ComponentProps<"div">`.                                                                                  |
| `WorkspaceViewport`  | `workspace-viewport`   | existing classes plus `[--page-header-h:3rem] [--page-toolbar-h:2.75rem]`                                             | Same `scrollId` prop and restoration behavior. Still one per page.                                                                                                                           |
| `WorkbenchViewport`  | `workbench-viewport`   | `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-md:h-(--workbench-mobile-h)`                                | No `scrollId`, no padding. `--workbench-mobile-h` is `calc(100dvh - 7rem)` (header 4rem + mobile toggle strip 3rem); it is the only permitted viewport calc and is declared in `styles.css`. |
| `WorkbenchBar`       | `workbench-bar`        | `flex h-10 shrink-0 items-center gap-1.5 border-b bg-background px-2`                                                 | Top bar. `size` prop `"default" \| "compact"`; compact is `h-9`. Add `role="toolbar"` and forward `aria-label`.                                                                              |
| `WorkbenchBody`      | `workbench-body`       | `flex min-h-0 min-w-0 flex-1`                                                                                         | Row container for canvas + optional rail. Add `flex-col` via `className` for a bottom panel.                                                                                                 |
| `WorkbenchCanvas`    | `workbench-canvas`     | `relative min-h-0 min-w-0 flex-1`                                                                                     | The element a tool measures. `overflow-hidden` by default; the tool decides inner scroll.                                                                                                    |
| `WorkbenchRail`      | `workbench-rail`       | `hidden w-88 shrink-0 flex-col overflow-y-auto border-s bg-background lg:flex`                                        | Right inspector rail. A `div`/`aside`; independently scrollable (a column, not a nested scroller).                                                                                           |
| `WorkbenchStatusBar` | `workbench-status-bar` | `flex h-7 shrink-0 items-center gap-3 border-t bg-muted/30 px-3 font-mono text-xs text-muted-foreground tabular-nums` | Bottom bar; children are `span`s; use `ms-auto` for the right cluster.                                                                                                                       |

Update the file's header comment to describe both archetypes and the "one scroller per region" rule.

`(admin)/route.tsx`: add `md:has-[>[data-slot=workspace]]:overflow-hidden` to the `admin-viewport` classes so a filled workspace can never leave a second scrollbar. Nothing else in that file changes.

## Page chrome (`page-header.tsx`)

Exports, all forwarding `className` and props, all `ComponentProps<"div">` unless stated:

| Export                        | `data-slot`               | Classes                                                                                                                                                    |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                  | `page-header`             | `sticky top-0 z-10 flex min-h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 lg:px-6`                                          |
| `PageHeaderTitle` (`h1`)      | `page-header-title`       | `min-w-0 truncate font-heading text-lg font-semibold`                                                                                                      |
| `PageHeaderDescription` (`p`) | `page-header-description` | `hidden truncate text-xs text-muted-foreground md:block`                                                                                                   |
| `PageHeaderActions`           | `page-header-actions`     | `flex shrink-0 items-center gap-2`                                                                                                                         |
| `PageToolbar`                 | `page-toolbar`            | `sticky top-(--page-header-h) z-10 flex h-11 shrink-0 items-center gap-2 border-b bg-background px-4 lg:px-6`                                              |
| `PageContent`                 | `page-content`            | `flex min-w-0 flex-1 flex-col gap-4 p-4 lg:p-6`, with `cva` variants `width: "full" (default) \| "form" (mx-auto w-full max-w-3xl) \| "flush" (p-0 gap-0)` |
| `SectionHeader`               | `section-header`          | `flex min-h-8 items-center justify-between gap-2` (+ `SectionTitle` `text-sm font-semibold`, `SectionActions`)                                             |

`PageHeader` is deliberately **not** wrapped for padding: its own `px-*` is the same as `PageContent` so title and content align. Document in the file comment that `PageHeader` must be a direct child of the scroll viewport and never inside `PageContent`.

Update `AdminWorkspaceFrame`: delete the `[&_[data-slot=page-header]]:…` class string from `WorkspaceViewport`; render `<WorkspaceViewport scrollId={`workspace-${pathname}`}>{children}</WorkspaceViewport>` and nothing else changes (sidebar, mobile toggle). Update its doc comment.

## Dense table variant (`components/ui/table.tsx`)

The current `Table` wraps the `<table>` in a `table-container` with `overflow-x-auto`. That element becomes the scroll container for sticky descendants, so a sticky `thead` would stick inside it and never to the pane. Add `TableVariant = "default" | "card" | "pane"`. For `variant="pane"`: container `relative w-full overflow-visible` (no horizontal scroll: pane tables hide or truncate low-priority columns with responsive `hidden xl:table-cell` instead), table `rounded-none`, `TableHeader` `sticky top-[calc(var(--page-header-h)+var(--page-toolbar-h))] z-[1] bg-background` (through an `in-data-[variant=pane]:` variant so callers pass nothing), `TableRow` `h-9`, `TableHead`/`TableCell` `px-4 lg:px-6 first:ps-4 lg:first:ps-6` so the first column aligns with `PageHeader`. Pages without a `PageToolbar` set `[--page-toolbar-h:0px]` on the viewport. `default` and `card` are unchanged.

## Skeletons (`skeletons.tsx`)

All built on `@/components/ui/skeleton`. Each root has `role="status"`, `aria-busy="true"`, one `<span className="sr-only">{m.admin_ui_loading()}</span>`, a `data-slot`, and accepts `className`. Props are counts and sizes only.

| Component              | Props (defaults)                                 | Renders                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TableSkeleton`        | `rows=8`, `columns=5`, `dense=true` (`h-9` rows) | Header row + body rows of `h-4` bars with varied widths from a fixed width table (deterministic, no `Math.random`). `data-slot="table-skeleton"`                                                                                                                                                                  |
| `SidebarListSkeleton`  | `rows=8`                                         | Two-line rows (`h-4 w-2/3`, `h-3 w-1/2`) at the sidebar row height. `sidebar-list-skeleton`                                                                                                                                                                                                                       |
| `KeyValueGridSkeleton` | `items=6`, `columns=2\|3` (`2`)                  | A `dl`-shaped grid of label (`h-3 w-16`) over value (`h-4 w-32`). `key-value-grid-skeleton`                                                                                                                                                                                                                       |
| `ChartSkeleton`        | `className` for the box (default `h-48`)         | A bordered box with axis stubs and a flat low-contrast band; no gradient other than `Skeleton`'s own sheen. `chart-skeleton`                                                                                                                                                                                      |
| `StatStripSkeleton`    | `items=4`                                        | One-row strip with dividers (matches the compact stat strip). `stat-strip-skeleton`                                                                                                                                                                                                                               |
| `FormSkeleton`         | `fields=6`                                       | Label bar + `h-9` input blocks. `form-skeleton`                                                                                                                                                                                                                                                                   |
| `InspectorSkeleton`    | none                                             | Title row, `KeyValueGridSkeleton`, two section bars. `inspector-skeleton`                                                                                                                                                                                                                                         |
| `WorkbenchSkeleton`    | `variant: "terminal" \| "logs" \| "topology"`    | `WorkbenchBar` with 3-5 control blocks, a canvas region (terminal: dark `bg-terminal` block; logs: 18 monospace-width rows; topology: dot-grid placeholder with five node outlines and a rail skeleton from `lg`), and a `WorkbenchStatusBar`. Fills `WorkbenchViewport` (`flex-1 min-h-0`). `workbench-skeleton` |
| `PageSkeleton`         | `children`                                       | `PageHeader` placeholder (title bar `h-5 w-40`) + `PageContent` hosting children. `page-skeleton`                                                                                                                                                                                                                 |

## `StatusDot` (`components/ui/status-dot.tsx`)

`StatusDot({ tone, pulse, className, ...span })`: a `span` `size-2 shrink-0 rounded-full`, `data-slot="status-dot"`, `aria-hidden` unless a `label` prop is passed (then `role="img"` with `aria-label`). `tone` via `cva`: `success → bg-success`, `warning → bg-warning`, `info → bg-info`, `danger → bg-destructive`, `muted → bg-muted-foreground/64`. `pulse` adds `motion-safe:animate-pulse` only for transitional states (connecting, applying). Used by the server tab bar, terminal bar, logs bar and topology nodes.

## Styles and tokens (`styles.css`)

Add (both themes where the value differs; keep the existing ordering and formatting style):

1. `@theme inline { --breakpoint-3xl: 120rem; }`
2. Terminal tokens in `:root` and `.dark` (the terminal is a dark island in both themes; values may be identical): `--terminal-background`, `--terminal-foreground`, `--terminal-cursor`, `--terminal-selection`, and the 16 ANSI colors `--terminal-black … --terminal-bright-white`. Seed them with the values currently hard-coded in `components/terminal/xterm-terminal.tsx`. Map `--color-terminal: var(--terminal-background)` in `@theme inline` so `bg-terminal` works.
3. `:root { --workbench-mobile-h: calc(100dvh - 7rem); }`
4. React Flow: `@import "@xyflow/react/style.css";` at the top with the other imports, then a `.react-flow { … }` block that sets **every** `--xy-*` variable used by `node_modules/@xyflow/react/dist/style.css` to a Blossom token: background `var(--background)`, dot/line grid `var(--border)`, node background `var(--card)`, node border `var(--border)`, node color `var(--card-foreground)`, selected border `var(--ring)`, edge stroke `var(--muted-foreground)`, selected edge stroke `var(--foreground)`, handle background `var(--background)`, handle border `var(--muted-foreground)`, controls and minimap colors from `--card`/`--border`/`--muted`, attribution background transparent. Read the dist CSS to get the exact variable names and the `.dark`/`.light` selectors; because Blossom themes through its own `.dark` class on `html`, Topology passes the library's fixed light color mode and relies on these overrides for both themes. Add `.react-flow__node { transition: none; }` and `@media (prefers-reduced-motion: reduce) { .react-flow__edge-path { animation: none !important; } }`. Edge dash animation is switched on by worker D through the edge `className` `blossom-edge-active`; declare it here: `.react-flow__edge.blossom-edge-active .react-flow__edge-path { stroke-dasharray: 6 4; animation: blossom-edge-dash 1s linear infinite; }` with `@keyframes blossom-edge-dash { to { stroke-dashoffset: -10; } }` (declared at top level, not inside `@theme`). Static dash and dotted styles are applied by D with inline `strokeDasharray`.
5. Hide the React Flow attribution only if the license terms allow it for the pinned version; otherwise keep the default attribution and make it unobtrusive. Report which in the PR.

Do not add gradients, glows or shadows.

## Dependency

`pnpm --filter @blossom/app add @xyflow/react@^13.0.3`. Verified metadata for 13.0.3: peers `react >=18`, `react-dom >=18` (React 19.3 is satisfied), dependencies `zustand ^5.0.15`, `classcat`, `@xyflow/system 1.0.1`, `react-compiler-runtime`; ESM only; `sideEffects: ["*.css"]`; exports `./style.css`, `./base.css`, `./xy-theme.css`; node ≥ 20. Confirm that `pnpm build`, `build:node` and `build:vercel` still succeed and that importing `@xyflow/react` in a client component does not enter the Cloudflare worker bundle unexpectedly (Topology renders client-only). Do not add any other dependency.

## i18n keys (`admin_ui_`)

`admin_ui_loading` ("Loading"), `admin_ui_retry`, `admin_ui_refreshing`, `admin_ui_load_error`, `admin_ui_empty_title`, `admin_ui_stat_strip_label`. Add only what the components above use. Provide Simplified Chinese translations in `zh-cn.json`.

## Tests and verification

No Node-testable logic exists in this workstream. Required:

```bash
pnpm --filter @blossom/app exec tsc --noEmit
pnpm fmt && pnpm lint
pnpm test
pnpm build && pnpm --filter @blossom/app build:node && pnpm --filter @blossom/app build:vercel
```

Manual checks (use the preview tools; temporary scratch routes must not be committed): render `PageHeader` + long `PageContent` inside `WorkspaceViewport` and confirm the header stays solid with no gutter bleed at 1280 and 2560 px; confirm `WorkbenchViewport` has no scrollbar and fills the pane at `md` and above; confirm both themes render the skeletons without layout shift against a populated version.
