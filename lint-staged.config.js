/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  "app/**/*.{js,jsx,ts,tsx,json,css,md}": "oxfmt",
  "app/**/*.{js,jsx,ts,tsx}": "oxlint --fix --deny-warnings",
  // Rust (server-agent). Run once on the whole crate rather than per-file:
  // cargo fmt/clippy operate on the crate, not individual paths. lint-staged
  // re-stages the matched .rs files after fmt rewrites them.
  "server-agent/**/*.rs": () => [
    "cargo fmt --manifest-path server-agent/Cargo.toml --all",
    "cargo clippy --manifest-path server-agent/Cargo.toml --all-targets --all-features --fix --allow-dirty --allow-staged -- -D warnings",
  ],
};
