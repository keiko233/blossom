# 07 Rule sets (worker E, Wave 2)

Goal: a Rule sets workbench with two first-class ways to add a binary rule set (**import from the official sing-box repositories** and **author custom rules compiled to `.srs`**), plus the existing manual upload, shown in a dense table. Requires W1 merged. The custom half also requires W2 (`app/src/lib/srs/`, [02](02-srs-codec.md)); the official import half does not, so start with it. Read [UI design standard](../../development/ui-design.md) first.

## Invariants that must not change

- `managed_rule_set_asset` rows are immutable `(rule_set_id, version)`; `format = 'binary'`; `size_bytes BETWEEN 1 AND 524288`; `sha256` lowercase hex; `source` text; `content_base64` canonical padded base64. No schema, migration, contract or agent change in this workstream. The agent accepts only `.srs` (`server-agent/src/config_managed.rs` rejects non-`SRS` magic; `sing-box check` validates the staged file).
- All persistence goes through the existing `importRuleSetAssetDraft` in `query/networking-write.ts` (it re-validates base64, the 512 KiB bound and computes the SHA-256). New code produces bytes and calls it; it does not insert rows itself.
- Every admin server function calls `ensureAdmin()`; every `POST` carries `adminAudit(...)`. `lib/admin-audit.test.ts` fails otherwise.
- Importing an asset does not change what any agent must apply (assets are inert until a routing draft references them and a rollout is planned), so it does **not** record a `config_change`, exactly like today's `importRuleSetPreset`.
- Secrets: no tokens or credentials are involved. Do not log fetched bytes.

## Files

Create:

- `app/src/query/networking-rule-sets.ts` (server functions)
- `app/src/lib/github-rule-set-catalog.ts` + `github-rule-set-catalog.test.ts` (pure allowlist, URLs, id/version derivation)
- `app/src/lib/networking-rule-set-schema.ts` + `networking-rule-set-schema.test.ts` (zod for the new server functions, origin classification)
- UI under `app/src/routes/(admin)/admin/networking/_modules/`: `rule-set-table.tsx`, `rule-set-official-sheet.tsx`, `rule-set-custom-sheet.tsx`, `rule-set-upload-dialog.tsx` (the current import dialog, moved), `use-rule-set-official.ts`, `use-rule-set-custom.ts`

Modify:

- `networking/rule-sets.tsx` (rewrite; thin route)
- `app/src/lib/networking-schema.ts` (add the new write reason codes if they are enumerated there; see below)
- `networking/_modules/networking-write-message.ts` (map the new reasons)
- `app/src/lib/admin-audit.ts` (register `networking.rule_set_import_official` and `networking.rule_set_create_custom`; target type `managed_rule_set_asset` already exists)
- `app/src/lib/networking-workspace.ts` (`MANAGED_RULE_SET_PRESET_CATALOG`: update the doc comment, which currently says presets are "not remote downloads"; map each preset to its official file name; remove any preset whose file does not exist upstream after you check the live tree)
- `docs/development/architecture.md` (add a short note in the security section: the control plane makes allowlisted outbound requests to `api.github.com` and `raw.githubusercontent.com` for rule-set import)
- i18n: prefixes `admin_networking_rulesets_official_`, `admin_networking_rulesets_custom_`, `admin_networking_rulesets_table_`, inserted after `admin_networking_rulesets_used_by`; `admin_networking_write_upstream_*` inserted after `admin_networking_write_duplicate_rule_set`

Delete nothing that other pages use. `lib/admin-audit.ts` labels for the new actions: follow how `networking.rule_set_import` is labeled (search `audit-labels.ts`, add both locales).

## Official repositories: what was verified (2026-11-26)

- Two repositories, branch `rule-set`: `SagerNet/sing-geosite` (files `geosite-<name>[@<attribute>].srs`, for example `geosite-cn.srs`, `geosite-apple.srs`, `geosite-acer@cn.srs`, `geosite-airchina@!cn.srs`, `geosite-category-ads-all.srs`) and `SagerNet/sing-geoip` (`geoip-<cc|name>.srs`, for example `geoip-cn.srs`, `geoip-us.srs`). Branch head of `sing-geosite` was commit `8b8788649349cf73fcd12fc81a5cae580e60360c` (2026-11-25, "Update rule-set"). The geosite tree listing is about 467 KB of JSON (well over a thousand files); the geoip tree about 53 KB.
- Largest files seen: `geoip-us.srs` ≈ 147 KiB, `geosite-category-companies.srs` ≈ 63 KiB, `geosite-cn.srs` 60,367 B. All are far below the 512 KiB cap, but the cap is still enforced.
- All files fetched for verification have header `53 52 53 01` (version 1).
- `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs` and `…/sing-geoip/rule-set/geoip-cn.srs` return the files (verified). Commit-pinned URLs (`…/<40-hex-sha>/<file>`) are immutable and are what the import uses.
- Not verified here: whether `geoip-private.srs` and `geosite-private.srs` exist (the current preset list assumes so), and unauthenticated GitHub API rate limits from your hosting provider's egress IPs (60 requests/hour per IP). Check the live tree when updating the presets, and implement the fallbacks below.

## Server functions (`query/networking-rule-sets.ts`)

All input is validated by the zod schemas in `lib/networking-rule-set-schema.ts` using `.validator(...)`, then `await ensureAdmin()`.

### `listOfficialRuleSets` (GET, no audit; read-only)

`createServerFn({ method: "GET" })` → `{ ok: true, fetchedAt: string, repos: Array<{ repo: "geosite" | "geoip"; commit: string; committedAt: string | null; entries: Array<{ name: string; file: string; sizeBytes: number }> }> } | { ok: false, reason: "upstream_unavailable" | "upstream_rate_limited" }`.

1. For each repo, `GET https://api.github.com/repos/SagerNet/<repo>/branches/rule-set` to get `commit.sha` and `commit.commit.committer.date`, then `GET …/git/trees/<tree-sha>` (non-recursive; the files are at the root). Keep only `type === "blob"` entries whose `path` matches `^geo(site|ip)-[a-z0-9][a-z0-9@!._-]*\.srs$` and whose `size` is 1..524288. Map to `{ name: path without prefix and ".srs", file: path, sizeBytes }`, sort by name.
2. A module-level `Map` cache with a 10-minute TTL (best effort per isolate; correctness never depends on it). Return the cached value on upstream failure if one exists (mark `stale: true`).
3. Slim response only (no tree SHAs, no URLs). The client list is virtualized.

### `importOfficialRuleSet` (POST, audited)

Middleware: `adminAudit("networking.rule_set_import_official", { targetType: "managed_rule_set_asset", targetId: fromInput("name") })`. Input: `{ repo: "geosite" | "geoip", name: string }` where `name` is the file name without the `geosite-`/`geoip-` prefix and the `.srs` suffix, validated by `^[a-z0-9][a-z0-9@!._-]{0,80}$` (no slashes, no `..`, no percent signs, no uppercase).

Algorithm (`lib/github-rule-set-catalog.ts` holds the pure parts):

1. Build `file = "<geosite|geoip>-<name>.srs"`. The **only** hosts are the constants `api.github.com` and `raw.githubusercontent.com`; the **only** repositories are `SagerNet/sing-geosite` and `SagerNet/sing-geoip`; the only ref used in a URL is either the literal branch `rule-set` or a 40-hex commit SHA that the server obtained from the GitHub API response itself. No user-supplied URL, host, path segment or ref is ever interpolated. Export `officialRuleSetUrls(repo, file, sha?)` and test that hostile `name` values (`../x`, `a/b`, `a%2fb`, `A`, empty, 300 chars, unicode) are rejected before any URL exists.
2. Resolve the pin: fetch the branch head (`/branches/rule-set`) to get `sha` and the commit date. If the API is rate limited or fails, fall back to the branch URL and derive the pin from the content hash instead (step 6).
3. `fetch("https://raw.githubusercontent.com/SagerNet/<repo>/<sha>/<file>", { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/octet-stream" } })`. Non-200 → `upstream_not_found` (404) or `upstream_unavailable`. Send no cookies or credentials and a generic `user-agent` (`blossom-control-plane`); never include the instance URL, user email or admin identity.
4. Size: reject early when `content-length` > 524288; then stream the body with a reader and abort as soon as the running total exceeds 524288 (`asset_too_large`). Zero bytes → `upstream_invalid_asset`.
5. Validate with the codec: `unpackSrs(bytes)` (magic `SRS`, version 1-5, bounded inflate) → on failure `upstream_invalid_asset`. Best-effort `inspectSrs` for the stats in the response (never fails the import).
6. Derive identity: `ruleSetId = <geosite|geoip>-<name>` with `@` → `-at-` and `!` → `-not-` and any other character outside `[a-z0-9._-]` rejected (≤ 64 chars, must match the existing `importRuleSetAssetSchema` id regex); `version = "<YYYY.MM.DD>-<sha7>"` from the commit date (UTC) and the first 7 hex of the commit SHA, or, in the fallback, the first 7 hex of the content SHA-256 with the response `Date` header date; `source = "github:SagerNet/<repo>@<sha>/<file>"` (≤ 512 chars).
7. Call `importRuleSetAssetDraft({ ruleSetId, version, source, contentBase64 }, db)` (base64 of the validated bytes). Return `{ ok: true, ruleSetId, version, sha256, sizeBytes, commit, stats }` or the existing `{ ok: false, reason, message }`; `duplicate_rule_set` means this exact pin is already imported (the UI shows "Already up to date").

New reason codes (add to the write-message map, both locales): `upstream_unavailable`, `upstream_not_found`, `upstream_rate_limited`, `upstream_invalid_asset`.

SSRF and supply-chain guardrails (all are requirements, with tests where pure): allowlisted hosts and repos as constants; `redirect: "error"`; no user-controlled URL components; timeout; streaming size cap; magic and bounded-inflate validation; commit-pinned fetch so a force-pushed branch cannot change bytes between the catalog and the import; admin-only; audited; no response body is logged or stored outside the validated DB row. Manual `.srs` upload remains for air-gapped installs and for sets from other sources.

### `createCustomRuleSet` (POST, audited)

Middleware: `adminAudit("networking.rule_set_create_custom", { targetType: "managed_rule_set_asset", targetId: fromInput("ruleSetId") })`. Input (`customRuleSetInputSchema`): `{ ruleSetId, version, mode: "structured" | "json", rules: unknown }` where `ruleSetId` and `version` use the same regexes as `importRuleSetAssetSchema`, and `rules` is the sing-box source shape (`{ rules: [...] }` or just the array) validated by the codec's `parseRuleSetSource` (so unsupported fields, bad domains/CIDRs/regexes return typed errors). Also bound the request: `rules` serialized ≤ 1 MiB.

1. `compileRuleSet(input)` (W2). On `SrsError`, return `{ ok: false, reason: "invalid_rules", message: <code>, issues: [{ code, path }] }` (the UI maps `code` to messages and highlights `path`). Over 512 KiB → `asset_too_large`.
2. `importRuleSetAssetDraft({ ruleSetId, version, source: "custom:" + mode, contentBase64 })`. Return `{ ok: true, ruleSetId, version, sha256, sizeBytes, stats }`.

There is no preview server function (it would be an unaudited POST). The client runs `parseRuleSetSource` and `encodePayload` itself (both isomorphic) to show validation errors, counts and an uncompressed-size estimate while typing, and may offer **Download .srs** using `compileRuleSet` client-side. The server result is authoritative.

## UI: the Rule sets workbench

The route is a document/table pane (R1): `WorkspaceViewport` → `PageHeader` → `PageContent width="full"`.

```text
PageHeader:  Rule sets                                        [＋ Add ▾]
                                                                ├ From sing-box repository…
                                                                ├ Create custom…
                                                                └ Upload .srs…
PageToolbar: [🔍 filter id…]  [Origin: All ▾]                         12 sets · 1.2 MiB of 2 MiB budget per server
PageContent: dense table (flush, no card)
```

- **Table** (`rule-set-table.tsx`, `data-slot="rule-set-table"`): columns ID (`font-mono`, copy button for the runtime tag `rule-set-<id>`), Version, Origin (`Badge size="sm"` `official | custom | upload`, from `ruleSetOrigin(source)`: `github:SagerNet/` → official, `custom:` → custom, anything else → upload), Size (`tabular-nums`, `formatBytes`), SHA-256 (first 12 hex + copy), Used by (count, tooltip lists server names), Created (`formatDateTime`). Row `Menu`: Copy tag, Copy SHA-256, **Duplicate as custom…** (opens the custom sheet prefilled by decoding the asset; disabled with a tooltip when the codec reports an unsupported item). From `xl` the selected row opens a right inspector rail (`grid-cols-[minmax(0,1fr)_22rem]`) with the full hash, source string, stats and the list of referencing servers; below `xl` it is a `Sheet`.
- Loading: `TableSkeleton`. Empty: compact `Empty` with the three add actions. Error: inline `Alert` + retry in the table's footprint. Keep the activation-disabled `Alert variant="info"` as a one-line notice row.
- Remove the old presets section. Presets become **quick picks** at the top of the official sheet.
- The budget line uses the existing constants (512 KiB per asset, 2 MiB aggregate raw per server, `MANAGED_SNAPSHOT_LIMITS`) in text, not a progress bar.

### Official sheet (`rule-set-official-sheet.tsx`)

`Sheet` (right, `sm:max-w-xl`). Content:

1. `Tabs variant="underline"`: **Geosite** | **GeoIP**. Under the tab strip: `DebouncedSearchInput` (existing component) and the repository commit and date in `text-xs` ("Updated 2026-11-25 · 8b87886").
2. Virtualized list (`@tanstack/react-virtual`, row `h-9`): checkbox, name (`font-mono`), size (`tabular-nums`), and an `Imported` badge when any version of `<repo>-<name>` already exists. Rows are keyboard operable (`Space` toggles, `↑ ↓` move). Quick picks above the list: the curated presets (`geosite-cn`, `geoip-cn`, `geosite-private`, `geoip-private` after verification) as small buttons that select the matching rows.
3. Footer (`SheetFooter`): `Import N selected` (`Button loading`). Imports run sequentially (concurrency 1) through `importOfficialRuleSet`, each result shown inline in a compact status list (`StatusDot` + id + `Imported` / `Already up to date` / reason text). Failures do not stop the batch. On completion invalidate the networking queries (`useInvalidateNetworking`) and keep the sheet open so the operator can review.
4. States: loading → `TableSkeleton`-style rows; `upstream_rate_limited`/`upstream_unavailable` → an `Alert` explaining that the catalog could not be loaded, an **Enter exact name** field (same `importOfficialRuleSet` call), the manual upload link, and a retry button. Never an infinite spinner.

### Custom sheet (`rule-set-custom-sheet.tsx`)

`Sheet` (right, `sm:max-w-2xl`; from `2xl` allow `max-w-3xl`). Header fields: ID, Version (default from `suggestRuleSetVersion(existingVersions)`: next integer when all existing versions of that id are integers, otherwise `YYYY.MM.DD`). Mode `ToggleGroup`: **Rules** (structured) | **JSON**.

- **Structured mode**: a list of rules, each an expandable row (Base UI `Collapsible`) separated by `border-b` (no card in card) with a summary line ("3 domains, 1 CIDR") and a remove button. A rule contains grouped field editors for: Domains (exact), Domain suffixes, Keywords, Regex, IP/CIDR (destination), Source IP/CIDR, Ports, Port ranges, Network (`ToggleGroup` tcp/udp/icmp), `Invert` switch. List fields use a multi-line `Textarea` (one value per line, with a live count and per-line error highlighting from `SrsError.path`) rather than chip inputs, because operators paste hundreds of lines. Semantics shown once in a tooltip: values inside one field are OR; different fields in one rule are AND; multiple rules are OR.
- **JSON mode**: a monospace `Textarea` accepting the sing-box source format (`{"version":3,"rules":[…]}`; unsupported fields produce `unsupported_field` with the path); a **Format** button; switching modes converts through `parseRuleSetSource` (blocked with an inline message when the JSON uses logical rules the structured editor does not model).
- Live feedback (client side, debounced 250 ms): validation errors with line/path, `stats`, and the uncompressed payload size; the footer shows `Save` (`Button loading`) and **Download .srs**. Saving calls `createCustomRuleSet`; `invalid_rules` highlights issues, `duplicate_rule_set` suggests the next version.
- Duplicate-as-custom: `unpackSrs` + `decodePayload` produce a `RuleSetSource`, shown in the editor with `version` set to the next suggestion. Not editable (unsupported items) → the action is disabled.

### Upload dialog

Move the current `RuleSetImportDialog` to `rule-set-upload-dialog.tsx` with its behavior unchanged, plus a client-side magic check (`53 52 53`) so an obviously wrong file fails before the round trip. Keep its form fields and hints.

## Pure helpers and tests

`lib/github-rule-set-catalog.ts`: `OFFICIAL_RULE_SET_REPOS`, `parseOfficialName(repo, name)`, `officialFileName(repo, name)`, `officialRuleSetUrls(repo, file, sha?)`, `deriveRuleSetId(repo, name)`, `deriveRuleSetVersion(commitDate, sha)`, `deriveSource(repo, sha, file)`, `filterCatalogTree(entries)`, `ruleSetOrigin(source)`, `suggestRuleSetVersion(existing)`.

Tests (`github-rule-set-catalog.test.ts`): hostile names rejected; URLs only ever use the two constant hosts and repos; ids for `cn`, `acer@cn`, `airchina@!cn` (`geosite-airchina-at-not-cn`), 64-char limit; versions `2026.11.25-8b87886`; source string; tree filtering (non-blobs, oversized files, bad names dropped; sorted); `ruleSetOrigin` for the three origins and odd inputs; `suggestRuleSetVersion` for integers, dates, empty and mixed.
Tests (`networking-rule-set-schema.test.ts`): `importOfficialRuleSetSchema` and `customRuleSetInputSchema` accept/reject tables; custom input over 1 MiB rejected; id/version regexes shared with `importRuleSetAssetSchema`.
The server functions' fetch logic is thin glue over the pure helpers and `fetch`; test the fetch-with-size-cap helper as an exported pure function that takes a `Response` (`readBodyCapped(response, limit)`) with `Response` objects built in the test: content-length over limit, body over limit without content-length, exact limit, empty.

## Verification

```bash
pnpm --filter @blossom/app exec vitest run src/lib/github-rule-set-catalog.test.ts src/lib/networking-rule-set-schema.test.ts src/lib/admin-audit.test.ts src/lib/srs
pnpm --filter @blossom/app exec tsc --noEmit
pnpm fmt && pnpm lint && pnpm test
pnpm build && pnpm --filter @blossom/app build:node && pnpm --filter @blossom/app build:vercel
```

Manual QA against a disposable local database (`DATABASE_URL` for a throwaway database only; never run `db:push`/`db:migrate` against anything else): list the official catalog, import `geosite-cn` and `geoip-cn`, confirm two table rows with `official` origin, the exact pinned version and `sha256` equal to the hash of the file at that commit, and that importing again reports "Already up to date"; create a custom set with domains, a suffix, a CIDR and a port, confirm it appears with `custom` origin; download its `.srs` and attach it to a routing draft; hostile inputs (`../x`, `cn/../../x`) fail at validation; with the network blocked the sheet shows the unavailable state, the exact-name field and the upload link. State clearly that real `sing-box` acceptance of generated files is verified in Wave 3.
