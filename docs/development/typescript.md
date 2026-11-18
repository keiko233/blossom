# TypeScript and React code style

Follow this guide for handwritten TypeScript and TSX across `app/` and `packages/{domain,contracts,database}`. Application layout, TanStack Start/Router/Forms, server functions, and Paraglide i18n rules live in [App conventions](app.md) and [API, data and auth](api-data-auth.md); verification rules live in [Testing and verification](testing.md).

Statements are **Established** unless marked **Recommended**.

## 1. Formatter, Lints, and Typechecking

- **Established (`.oxfmtrc.json`):** `oxfmt` formats with 2 spaces, LF, semicolons (`"semi": true`), trailing commas (`"trailingComma": "all"`), 80-column print width, double quotes by default (do not fight `oxfmt`), sorted import groups (`builtin`/`external`, `@/` internal, relative, styles), and sorted Tailwind classes inside `cn(...)` and `clsx(...)`. Generated `*.gen.*` files are ignored.
- **Established (`.oxlintrc.json`):** `oxlint` enables `eslint/no-unused-vars: "error"`. The pre-commit hook runs `oxfmt` and `oxlint --fix --deny-warnings` on staged files in `app/` and `packages/` ([Workflow](workflow.md#git-hooks)).
- **Established (`tsconfig.json`):** Strict TypeScript (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`). Always use `import type` for type-only imports, explicit domain types or Zod inference, and `unknown` plus narrowing for untrusted payloads. Avoid `any` or `@ts-ignore`.
- **Established (workspace packages):** `packages/{domain,contracts,database}` expose TypeScript source entry points consumed directly by `@blossom/app` and Vitest; keep client-safe contracts free of server/database imports (`tanstackStart` `importProtection` denies `@blossom/database/server` in client bundles).
- **Recommended:** Run `pnpm --filter @blossom/app exec tsc --noEmit` after non-trivial TypeScript changes, because CI runs `vite build` + `vitest run` without invoking `tsc --noEmit` ([Testing and verification](testing.md#commands)).

## 2. Group Code by Responsibility

- **Recommended:** Separate distinct responsibilities inside hooks, server functions, and components with a single blank line — for example: router/query-client access, query setup, mutation setup, derived values, effects/event handlers, and the final `return`.
- **Recommended:** Keep related statements grouped together without putting blank lines after every single declaration. Attach explanatory comments to the responsibility group they describe, and keep compact early-return guards uncluttered.

```ts
export function useServerActions(serverId: string) {
  const queryClient = useQueryClient();

  const regenerateMutation = useMutation({
    mutationFn: () => regenerateServerToken({ data: { id: serverId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY }),
  });

  const handleRegenerate = useLockFn(async () => {
    const token = await regenerateMutation.mutateAsync();
    return token;
  });

  return { regenerateMutation, handleRegenerate };
}
```

## 3. Reuse Constants, Schemas, and Environment Boundaries

- **Established:**
  - Read client build-time vars (`VITE_*`) through `app/src/lib/env-client.ts`; read server env lazily through `getServerEnv()` (`app/src/lib/env.ts`).
  - Keep client-shared constants beside, not inside, Drizzle schema files that pull in database drivers (see `app/src/lib/admin-audit.ts`).
  - Keep pure domain logic portable in `packages/domain/` and shared validation contracts in `packages/contracts/` or `app/src/orpc/proxy/schema.ts`.
- **Recommended:** Before introducing a constant, enum, or runtime capability check, search `packages/{domain,contracts}` and `app/src/lib/` for an existing definition. Promote constants only when multiple real consumers share the same semantic meaning; keep one-off UI literals local.

## 4. `data-slot` Attributes and UI Styling (`cva()` + `cn()`)

- **Established:** UI primitives in `app/src/components/ui/` are built on `@base-ui/react` and already use `data-slot` attributes (e.g., `button`, `dialog-content`, `field`), `class-variance-authority` (`cva`), and `cn()` from `@/lib/utils`.
- **Recommended (`data-slot`):** Place descriptive lowercase kebab-case `data-slot` attributes on reusable component roots and meaningful structural parts that reach the DOM (such as `server-telemetry-card`, `terminal-viewport`, `ssh-fallback-banner`). Wrappers must forward `data-*` props or apply `data-slot` on their rendered DOM root; do not add extra wrapper `<div>`s solely for a slot, and never replace accessible labels (`aria-label`), semantic HTML, or React `key`s with `data-slot`.
- **Recommended (`cva()` and `cn()`):**
  - Use `cva(...)` from `class-variance-authority` for reusable or variant-driven class definitions (suffix names in camelCase with `Variants`, e.g., `statusBadgeVariants`). Never extract Tailwind strings into `*_CLASS` or `*_CLASSES` constants.
  - Keep short one-off layout classes inline. When a Tailwind class list grows long, split it across multiple lines grouped by responsibility (layout/sizing → surface/border/typography → interaction/focus/motion) using multiple string arguments to `cn(...)` or an array first argument in `cva([...])`.

```tsx
const statusBadgeVariants = cva(
  [
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
    "text-xs font-medium transition-colors",
  ],
  {
    variants: {
      tone: {
        online: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
        offline: "border-border bg-muted text-muted-foreground",
      },
    },
  },
);
```

- **Established UI boundary:** Compose `@base-ui/react` primitives through `app/src/components/ui/*`; do not scatter raw Base UI styling or parallel design tokens inside feature pages.

## 5. Component Composition and Dialog / Modal Lifecycle

- **Recommended (Composition):**
  - Compose compound controls explicitly (`Select` / `SelectTrigger` / `SelectContent` / `SelectItem`, `Field` / `FieldLabel` / `FieldDescription`) rather than building monolithic wrapper components with dozens of boolean/render props.
  - Keep state with the nearest owner; lift into a route- or feature-scoped context only when multiple sibling/descendant components genuinely share it without prop-drilling. Never store ephemeral credentials (such as Web SSH passwords/private keys) in URL search params, `localStorage`, or broad global stores.
- **Recommended (Modals and Async Forms):**
  - Keep dialog roots and content mounted across open/close transitions so exit animations and focus restoration work cleanly; avoid `{open && <Dialog />}` unless intentionally tearing down sensitive in-memory state (in which case clear secrets explicitly on close/unmount too).
  - For destructive confirmations, use the existing imperative `Confirm.call({...})` (`app/src/components/ui/confirm.tsx`).
  - Disable submit and close controls while async mutations are in flight, guard submit handlers with `useLockFn` (`app/src/hooks/use-lock-fn.ts`) after preventing default form submission, and keep dialogs open with inline error feedback when validation or server calls fail. Reset form drafts on open, not mid-exit animation.

## 6. Routed Pages, Module Scope, and i18n Grouping

- **Established:** File-based routes live in `app/src/routes/` (with `(admin)`, `(user)`, `(auth)`, `(static)`, and `api/`), ignoring `_modules/` via `routeFileIgnorePattern`. Admin group routes check role in `beforeLoad`, and every admin server function checks `ensureAdmin()`.
- **Recommended:**
  - Scope `_modules/` tightly to actual consumers: page-only helpers/components belong in that page's `_modules/` folder; promote to a parent `_modules/` or `app/src/components/` only when multiple pages genuinely share them.
  - Keep new Paraglide message keys grouped beside related keys in the same logical order in both `app/messages/en.json` and `app/messages/zh-cn.json` (never append unrelated keys haphazardly to the end of only one locale).

## 7. Review Checklist

Formatting and lint passing does not finish TypeScript/React review. Before completing a change, verify:

1. Distinct responsibilities are cleanly separated by single blank lines; no giant single-line Tailwind strings or `*_CLASS` constants.
2. Reusable UI parts sit in `components/ui/` or route-appropriate `_modules/` with clear `data-slot` names and `cva()`/`cn()`.
3. Client bundles import zero server-only modules (`@blossom/database/server`, `@/db`, `node:*`) and persist zero ephemeral secrets.
4. Both `app/messages/en.json` and `app/messages/zh-cn.json` stay in sync, and `tsc --noEmit`, `pnpm test`, and affected `build:<target>` checks pass.
