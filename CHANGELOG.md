# Changelog

All notable changes to Blossom.
## v1.5.0 - 2026-11-21

### Added

- Add workspace shell and canonical routes (#197)

- Persist membership order and sort exports (#198)

- Add subscriber ingress and ordered group editing (#199)

- Add opt-in native systemd supervision (#200)

- Persist traffic metering across restarts (#201)

- Persist managed topology and rollout stages (#202)

- Compile and apply managed agent snapshots (#203)

- Orchestrate rollouts and authenticate link probes (#204)

- Build the managed networking workspace (#205)

- Enable managed rollouts by default (#206)


### Fixed

- Update rust crate base64 to 0.23 (#183)

- Retry db:migrate on transient connection errors (#193)


### Maintenance

- Update dependency @iconify/json to v2.2.559 (#181)

- Build after publishing the draft release (#186)

- Update dependency @tanstack/react-devtools to v0.10.15 (#187)

- Update postgres docker tag to v19 (#192)

- Update tanstack-router monorepo (#191)

- Update rust crate clap to v4.6.9 (#189)

- Update better-auth monorepo to v1.7.27 (#195)

- Update dependency tailwind-merge to v3.7.1 (#188)

## v1.4.0 - 2026-11-19

### Added

- Add server routing and PTY shell foundation (#173)

- Add the WebSocket v2 control plane (#174)

- Add agent identity enrollment and rotation (#175)

- Run admin operations over the v2 lifecycle (#176)

- Complete the agent operations workspace and v2 rollout (#177)


### Changed

- Unify app and server-agent release versioning (#185)


### Documentation

- Specify the agent operations workspace (#172)


### Fixed

- Update rust crate progenitor-client to 0.16.0 (#105)

- Let agent tag trigger binary release

- Guard db:migrate against Hyperdrive drift (#184)


### Maintenance

- Update pnpm/action-setup action to v6 (#63)

- Update github artifact actions (#62)

- Update rust crate zeroize to v1.9.2 (#126)

- Update dependency filesize to v11.0.34 (#81)

- Update better-auth monorepo to v1.7.26 (#118)

- Update dependency resend to v6.38.1 (#100)

- Update orpc monorepo to v1.16.2 (#84)

- Update dependency @cloudflare/vite-plugin to v1.70.1 (#180)

- Update dependency vitest to v5.1.1 (#120)

- Allow direct push with GITHUB_TOKEN and call downstream workflows

- Set minimumReleaseAge to 0

- Update dependency wrangler to v4.165.0 (#136)

# Changelog

All notable changes to the Blossom app.
## v1.3.0 - 2026-11-19

### Added

- Implement authentication flow with email sign-in and sign-up, add social login options

- Implement authentication schema and email magic link functionality

- Update package.json and pnpm-lock.yaml to include tanstack-theme-kit

- Add route configuration for admin proxies nodes and remove static data from existing route

- Add user profile menu with theme and language options, and integrate into admin sidebar

- Add plans management functionality

- Add user management

- Add Clash Meta schema and proxy handling

- Add DEPLOY_TARGET build switch for multi-platform deployment

- Add health endpoint and portable client IP helper

- Add Docker, Netlify, Vercel and Railway deployment configs

- Add user details title to admin user management and update app name in manifest

- Show one-line Docker deploy command in agent token dialog

- Enhance clash proxy configuration with reality options and multiplex support

- Add centralized format utilities backed by filesize, date-fns and ms

- Impl user authentication and subscription management

- Support multi-node sing-box servers

- Validate and report sing-box config state

- Add authenticated MCP server

- Support remote OAuth callbacks

- Add offline_access scope and update token expiration settings

- Centralize managed TLS certificates

- Enhance ACME certificate management with ZeroSSL support

- Add API route for exporting certificate parts

- Add loading states to async actions

- Implement certificate action handling and testing

- Implement config change recording for various operations

- Implement Hyperdrive connection handling and update database configuration logic

- Add admin management data model and server functions

- Add admin console pages and user onboarding

- Connect server node and certificate workflows

- Add password recovery flow

- Bootstrap first registered administrator

- Classify accounting capabilities

- Preview group and plan access impact

- Add safe owner credential rotation

- Manage agent and sing-box versions

- Add agent websocket realtime hub (#113)

- Add live Linux telemetry for server admins (#115)

- Add opt-in admin PTY over agent WebSocket (#116)

- Execute ACME issuance on issuer servers (#117)


### Changed

- Migrate to monorepo & impl server agent & sing-box schema form generator

- Replace hand-rolled byte formatting with format utilities

- Use format utilities for cents-amount conversion

- Centralize database queries

- Unify page headers and route links

- Unify managed tls control plane

- Extract domain and shared contracts

- Isolate database clients per worker request

- Remove obsolete File polyfill

- Use connection-stream user identifiers


### Fixed

- Update paraglide plugin strategy to use cookie

- Update env-schema to preprocess DATABASE_DRIVER and rename APP_NAME to VITE_APP_NAME

- Enable observability logs in wrangler configuration

- Shadowsocks proxy configuration with server PSK support

- Repair OAuth client registration schema

- Verify MCP tokens with local JWKS

- Route worker ACME requests publicly

- Restore Cloudflare worker startup

- Support certificate imports on neon-http

- Sanitize TLS settings to remove managed certificate fields

- Keep database code out of client bundle

- Update test script to include paraglide-js compilation

- Update dependency lucide-react to v1 (#66)

- Update dependency mcp-handler to v2 (#67)

- Load reflect-metadata before tsyringe in every bundle

- Migrate oauth schema for better-auth 1.7

- Upgrade migration snapshots for drizzle kit

- Build Netlify from workspace root

- Fail safely when magic link delivery fails

- Distinguish delivery failure causes

- Make traffic reports replay safe

- Preserve locale during server rendering

- Resolve proxy nav labels at render time

- Stabilize node table data

- Update dependency drizzle-orm to v1.0.0-rc.5-ab785fc (#14)

- Revert drizzle-kit canary (#107)

- Bind Hyperdrive database (#109)

- Align app version and remove prereleases


### Maintenance

- Add date-fns, filesize and ms dependencies

- Update dependency commitlint to v21.2.1 (#6)

- Update dependency @iconify/json to v2.2.498 (#2)

- Update dependency @types/node to v22.20.1 (#5)

- Update dependency resend to v6.17.2 (#9)

- Update dependency vite to v8.1.4 (#10)

- Update orpc monorepo to v1.14.8 (#12)

- Update dependency vitest to v4.1.10 (#11)

- Update packageManager to pnpm@11.13.0

- Update dependency @tanstack/react-form to v1.33.2 (#3)

- Update dependency lucide-react to v1.47.0 (#50)

- Update fontsource monorepo to v5.3.0 (#42)

- Update dependency lint-staged to v17.5.1 (#39)

- Update dependency resend to v6.28.1 (#40)

- Update dependency @base-ui/react to v1.8.0 (#36)

- Update dependency @modelcontextprotocol/sdk to v1.30.0 (#37)

- Update dependency @tanstack/react-form to v1.33.5 (#24)

- Update dependency pg to v8.23.0 (#38)

- Update dependency @tanstack/react-devtools to v0.10.12 (#23)

- Update tailwindcss monorepo to v4.3.3 (#34)

- Update dependency oxlint to v1.83.0 (#19)

- Update dependency oxfmt to ^0.68.0 (#18)

- Update dependency @iconify/json to v2.2.530 (#7)

- Update pnpm to v11.27.0 (#44)

- Update dependency typescript to v7 (#56)

- Update dependency node to v24 (#55)

- Upgrade project dependencies and node to 26

- Use Nitro for Netlify deployment

- Update dependency @neondatabase/serverless to v1.2.1 (#76)

- Update dependency meta-json-schema to v1.19.33 (#15)

- Update better-auth monorepo to v1.7.25 (#74)

- Update dependency @types/node to v26.6.6 (#78)

- Update dependency drizzle-kit to v1.0.0-rc.5-ab785fc (#8)

- Update dependency @tanstack/react-devtools to v0.10.14 (#77)

- Update dependency vite to v8.3.8 (#83)

- Update dependency @iconify/json to v2.2.558 (#75)

- Update dependency lint-staged to v17.6.1 (#82)

- Update dependency @rolldown/plugin-babel to ^0.3.0 (#94)

- Update dependency dotenv to v18.0.10 (#80)

- Update tailwindcss monorepo to v4.3.5 (#91)

- Update dependency @vitejs/plugin-react to v6.3.0 (#95)

- Update dependency mcp-handler to v2.4.0 (#97)

- Update dependency vitest to v5.1.0 (#101)

- Drop Netlify and add semver publish workflow (#114)

- Update tanstack-router monorepo (#92)

- Update dependency oxfmt to ^0.79.0 (#98)

- Update dependency wrangler to v4.164.0 (#102)

- Update dependency oxlint to v1.94.0 (#99)

- Update dependency @cloudflare/vite-plugin to v1.70.0 (#93)

- Update pnpm to v12.21.0 (#103)

- Update react-email monorepo to v6.11.15 (#85)

- Update dependency @inlang/paraglide-js to v3 (#106)

- Update tanstack-query monorepo to v5.108.0 (#104)

