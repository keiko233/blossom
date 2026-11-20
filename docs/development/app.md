# App conventions (TypeScript and React)

Applies to `app/`. Server-side API, data and auth rules are in [API, data and auth](api-data-auth.md); generated files are in [Generated files](generated-files.md).

Statements are **Established** (what the code does today) unless marked **Recommended**.

## Toolchain

- React 19 with the React Compiler enabled (`babel-plugin-react-compiler` through `@rolldown/plugin-babel` in `vite.config.ts`), TanStack Start/Router/Query/Form/Table, Tailwind CSS v4, Vite 8, TypeScript 7, Vitest 5.
- `tsconfig.json` is strict with `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`. Use `import type` for type-only imports. The `@/*` alias maps to `app/src/*`; prefer it over deep relative paths (same-folder `./` imports are normal).
- **Recommended**: with the compiler on, do not add `useMemo`/`useCallback`/`memo` by default. Add them only for a measured problem or a reason the compiler cannot see (for example a stable identity required by an external API).

## Formatting and lint

Established, from `.oxfmtrc.json` and `.oxlintrc.json` at the repo root:

- Formatter is `oxfmt`: 2-space indent, semicolons, trailing commas, 80 columns, LF. It sorts imports into groups (builtin/external, then `@/` internal, then relative, then styles) and sorts Tailwind classes inside `cn(...)` and `clsx(...)`. `*.gen.*` files are ignored.
- Linter is `oxlint` with a single enabled rule, `no-unused-vars` (error). Passing lint is a low bar; follow the conventions below on top of it.
- `pnpm fmt` and `pnpm lint` run these from the repo root. The pre-commit hook runs them on staged `app/` files (see [Workflow](workflow.md#git-hooks)).

## Layout of `app/src`

| Path                                | Holds                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `routes/`                           | File-based TanStack Router routes. Pathless groups `(admin)`, `(user)`, `(auth)`, `(static)`; `api/` for HTTP handlers.       |
| `routes/**/_modules/`               | Components, hooks and helpers private to one route. The router ignores `_modules` (`routeFileIgnorePattern`).                 |
| `components/ui/`                    | shadcn-style primitives built on `@base-ui/react` (see `components.json`). Add new primitives here.                          |
| `components/`                       | Shared, app-specific components (`app-shell/`, `schema-form/`, `charts/`, tables, pagination, …).                            |
| `query/`                            | Server functions and server-side data access, plus the TanStack Query keys the UI uses. See [API, data and auth](api-data-auth.md). |
| `lib/`                              | Domain logic, schemas, search/filter helpers, formatting, env. Most unit tests live here.                                    |
| `orpc/`                             | The agent oRPC router, sing-box config compilation (`orpc/proxy/`), and the MCP router (`orpc/mcp/`).                         |
| `db/`                               | Drizzle schemas, DB client and driver selection.                                                                             |
| `hooks/`, `providers/`, `integrations/` | Small shared hooks, context providers, TanStack Query root setup.                                                       |
| `templates/emails/`                 | react-email templates (`pnpm --filter @blossom/app email:dev` previews them).                                               |
| `paraglide/`, `route-tree.gen.ts`   | Generated. Do not edit.                                                                                                      |

## Routes and pages

- Put the route file (`index.tsx`, `new.tsx`, `$id.tsx`) in the feature folder, keep it thin, and put page-private pieces in that folder's `_modules/`. Dialogs, toolbars, form pages and `use-*` hooks follow this pattern throughout `(admin)/admin/`.
- Auth and role gating live in the group route's `beforeLoad` (for example `app/src/routes/(admin)/route.tsx` redirects non-admins). Gating in the UI is not a security boundary; the server functions that serve admin data check again with `ensureAdmin()`.
- Routes that should appear in the breadcrumb set `staticData.crumb` (a function returning a translated string), which `AutoBreadcrumb` renders; the admin pages inspected do this.
- List pages keep filters, sort and page in validated URL search params. The zod schema and the search-to-filter mapping live in `lib/*-search.ts` / `lib/*-filters.ts` with unit tests (for example `lib/user-search.ts`), not inline in the page.
- The pages inspected declare `function RouteComponent(): React.ReactElement`; match that in new pages.

## Data fetching and mutations

- Call server functions from `useQuery`/`useMutation`: `queryFn: () => listServers()`, `mutationFn: (id) => deleteServer({ data: { id } })`.
- Query keys that more than one place needs are exported from the owning `query/` module (`SERVERS_QUERY_KEY`). Invalidate with those constants after a mutation.
- Report outcomes with `toastManager.add({ type, title })` using translated titles. Ask for confirmation of destructive actions with the imperative `Confirm.call({...})` (`components/ui/confirm.tsx`, built on `react-call`); admin layouts mount its host once.
- Show one-time secrets (agent tokens, redeem codes) in the dedicated reveal dialogs rather than in toasts or logs.
- Use `useLockFn` (`hooks/use-lock-fn.ts`) to stop double-submits of an async handler.

## Forms

- Forms use `@tanstack/react-form`. Non-trivial forms get a `use-*-form.ts` hook in `_modules/` that owns default values, the payload mapping and the mutation, and a `*-form-page.tsx` component that renders it (see `servers/_modules/`).
- Validate on the server with the same zod schema the server function uses (schemas for proxy entities live in `orpc/proxy/schema.ts`, etc.). Do not rely on client validation alone.
- `components/schema-form/` renders forms from JSON schema (used for sing-box node settings). Reuse it before building a new schema-driven form.

## Internationalisation

- User-visible strings go through Paraglide: `import { m } from "@/paraglide/messages"` then `m.some_key()`. New code should not hard-code English or Chinese in components; I did not audit the existing code for exceptions.
- Messages live in `app/messages/en.json` (base locale) and `app/messages/zh-cn.json`, which currently have the same number of keys. Add new keys to both. Keys are snake_case and prefixed by area, for example `admin_proxies_servers_toast_deleted`.
- The generated `src/paraglide/` is rebuilt by `vite dev`/`vite build` and by `pnpm test`; see [Generated files](generated-files.md).
- `src/server.ts` wraps the Start handler with Paraglide's request middleware, so SSR uses the same locale cookie as the browser and concurrent requests retain separate locales. Cloudflare's `wrangler.jsonc` points to that entry as well.
- Do not match on translated error text to decide behaviour. **Recommended**: throw errors with a stable code or type and branch on that.

## UI composition

- Build on `components/ui/*` and the existing shared components before adding new markup. Use `lucide-react` icons (`XxxIcon` names) and `cn()` from `@/lib/utils` for class merging.
- `FieldDescription` is a Base UI field part and requires a surrounding `Field` or `FormField`; use ordinary text for hints outside a field.
- The list pages inspected use `PageHeader` → toolbar → table, with `Empty` for empty states and `Spinner` for pending states; reuse those before inventing new patterns.
- The admin shell fills the viewport and admin pages scroll inside its `admin-viewport` container, not the window. A workspace with a context sidebar (the server workspace today) composes `Workspace`, `WorkspaceSidebar`, `WorkspacePane`, `WorkspaceHeader` and exactly one `WorkspaceViewport` from `components/app-shell/workspace.tsx`. The router resets that viewport on new navigations and restores it on Back; give it a `scrollId` scoped to the route and resource. `lib/admin-workspace.ts` owns the activity-rail workspaces and the map from pre-workspace admin URLs to their canonical destinations.
- Keep server-only imports (`@/db`, `node:*`) out of code that the browser bundles. Shared constants that the client needs are kept beside, not inside, the Drizzle table files for this reason (see the comment at the top of `lib/admin-audit.ts`). Use `createServerFn`/`createServerOnlyFn` at the boundary.
- Read client environment through `lib/env-client.ts`; read server environment through `getServerEnv()` in server-only code (see [API, data and auth](api-data-auth.md#environment) for the few direct `process.env` uses).

## Naming

- Files are kebab-case (`user-search.ts`, `use-server-form.ts`). Components are PascalCase, hooks start with `use`, tests sit next to the module as `*.test.ts`.
- Server functions are verb-first camelCase (`listServers`, `regenerateServerToken`); audit action names are dotted snake_case (`server.regenerate_token`).
