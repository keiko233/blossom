# Changelog

All notable changes to the Blossom server agent.
## server-agent-v1.4.0 - 2026-11-19

### Added

- Add server routing and PTY shell foundation (#173)

- Run admin operations over the v2 lifecycle (#176)

- Complete the agent operations workspace and v2 rollout (#177)


### Fixed

- Update rust crate progenitor-client to 0.16.0 (#105)


### Maintenance

- Update rust crate zeroize to v1.9.2 (#126)

## server-agent-v1.3.0 - 2026-11-19

### Added

- Prefer IPv6 for bootstrap GitHub requests (#110)

- Add push WebSocket client for instant sync (#112)

- Add live Linux telemetry for server admins (#115)

- Add opt-in admin PTY over agent WebSocket (#116)

- Execute ACME issuance on issuer servers (#117)


### Maintenance

- Update rust crate tonic to v0.14.9 (#89)

- Update rust crate tonic-prost to v0.14.9 (#90)

- Update rust crate clap to v4.6.8 (#86)

- Update rust crate prost to v0.14.6 (#87)

- Drop Netlify and add semver publish workflow (#114)

- Update rust crate progenitor to 0.16.0 (#73)

