# Changelog

All notable changes to the ERD Studio extension.

The `Unreleased` heading below is renamed to the released version by the deploy workflow
(`scripts/release.mjs changelog`). Add user-facing notes under it as part of each PR.

## Unreleased

### Fixed

- **Leaner marketplace package** — the `.vsix` no longer bundles internal planning and review notes, the `mcp-server` project metadata, or an unused 314 KB demo GIF. Only `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, the icons and the built `dist/` bundles ship. CI now fails if the packaged file list grows unexpectedly.
- **Releases only when something shipped changes** — docs-only, fixture-only and planning-only PRs no longer publish a new marketplace version (every release triggers a save-all + window reload for users with a canvas open).
- **Deploy resilience** — the version bump is now computed against the latest published marketplace version (so a desynced repo can no longer fail with "version already exists") and is committed and pushed *before* publishing, so a failed publish never leaves `main` behind the marketplace. The redundant duplicate production build during publish was removed.
- **CHANGELOG is maintained again** — the marketplace Changelog tab had been frozen at 0.6.27; the deploy workflow now stamps each release into this file.

### Internal

- `tsx` is declared as a dev dependency (the fixture-regeneration script no longer relies on `npx` auto-install).
- `@types/vscode` is pinned to `1.85.0` to match `engines.vscode`, so APIs newer than the minimum supported VS Code fail type-checking instead of throwing for users on older versions.
- Removed unused dev dependencies (`@resvg/resvg-js`, `@types/mocha`, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode-elements/*`) and the non-functional `test:integration` script.
- CI builds, type-checks and smoke-tests `mcp-server` (which shares `src/services` with the extension) on every PR.
- The disabled Claude PR-review workflow runs with read-only permissions, is gated to repository owners/members/collaborators, and its project rules reflect the `erdStudio` identifier rename.

## 0.6.27 — 2026-04-21

### Added

- **Inline column delete on the canvas** — hover any column on a model node to reveal a one-click delete button. Deleting a column also cascades to any relationships that referenced it, matching the existing behaviour for deleted models.

### Fixed

- **Self-reference relationships** (a model linking to itself) now render as a proper cubic-bezier loop arcing over the top-right corner of the node, instead of collapsing into the node body.
- **Double-click to add note** is now detected reliably across the entire canvas. The previous check silently dropped the gesture whenever the click target wasn't the exact React Flow pane element (for example, when an overlay or child element intercepted it). The "New Note" dropdown item also now advertises the gesture via tooltip.
- **Marketplace README** — header icon, demo GIF, and license badge now render correctly on the extension page. Images are served from a public assets repo (the source repo remains private) and the license badge is a static MIT badge.
