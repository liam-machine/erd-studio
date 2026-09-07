# Changelog

All notable changes to the ERD Studio extension.

The `Unreleased` heading below is renamed to the released version by the deploy workflow
(`scripts/release.mjs changelog`). Add user-facing notes under it as part of each PR.

## Unreleased

### Added

- **Report a Bug** — `ERD Studio: Report a Bug` (command palette, sidebar, canvas toolbar and error screens) opens a prefilled GitHub issue with diagnostics (versions, OS, domain summary, recent errors) and, from a canvas, copies a screenshot to the clipboard for pasting. Nothing is sent until you submit on GitHub.

### Fixed

- **Multi-select delete and drag are one undo step** — deleting a rubber-band selection that includes notes and standalone relationships now removes them in a single edit (one Cmd+Z restores everything, matching models), and dragging several notes together is persisted as one edit instead of one per note.
- **Undo/redo no longer double-saves** — each toolbar undo/redo wrote the domain file and re-rendered the canvas twice; it now does so once.
- **Undo/redo never saves a model file you are editing by hand** — a toolbar undo used to force-save *every* unsaved `logical-models/*.yml` buffer, including one open in another tab with work in progress. It now flushes only the files ERD Studio itself wrote for that domain.
- **Renaming a model on the canvas keeps comments and custom keys** — the renamed `logical-models/*.yml` is now carried over from the old file instead of being regenerated, so hand-written comments, key order and keys ERD Studio does not own survive the rename.
- **Adding an existing model writes nothing when the edit fails** — "Add Existing Model" seeded the library file before the domain edit, leaving an orphan `.yml` behind if the edit was rejected (and out of reach of undo). The file is now created in the same edit as the domain change.
- **"Add Existing Model" accepts every legal dbt model name again** — a hardening pass had started rejecting uppercase and digit-leading names (e.g. `DimCustomer`, `2024_snapshot`) that dbt itself allows. Names discovered in your dbt project are now only checked for file-path safety; the lowercase naming convention still applies to models you create or rename in ERD Studio.
- **One bad model name no longer blanks the whole canvas** — a hand-edited or AI-written domain file whose `logical.models` contained a name with a path separator failed to open at all. It now renders that single entry as a broken-reference node and draws the rest of the diagram.
- **Note resize is validated before it is written** — an `updateAnnotation` carrying a non-numeric width/height (or a non-string id) is rejected instead of writing `null` sizes into the domain file.
- **Migration only ever touches domain files** — an unrelated `.json` kept in a layer directory could be picked up as a migration candidate and silently restructured if you accepted the prompt. Only files with a `schemaVersion` are now considered.
- **Migration prompt names the real command** — the "unsupported domain format" message quoted a command title that does not exist; it now names **ERD Studio: Migrate Domains to Central Model Store** exactly as the palette shows it.
- **A refused layer change no longer leaves a phantom layer in the sidebar** — when `layers.json` cannot be read, ERD Studio refuses to overwrite it (so your file is never clobbered with defaults), but the add/rename/delete/recolour/reorder you attempted was still applied in memory: the tree, the layer badges and the "Create Domain" layer picker showed a layer that was not on disk until the window reloaded. The in-memory layers now stay exactly in step with the file.
- **Deleting a model cleans up its notes** — a canvas note linked to a deleted model kept a dashed edge pointing at a node that no longer exists. Removing models now clears those links (and their saved positions) the same way for both domain file formats.
- **No more redundant canvas refresh after an edit** — a column, grain or role change bounced back through the file watcher ~300 ms later and re-rendered the canvas a second time, clearing the selected column. The editor's own writes are now recognised and skipped, while other open domains showing the same model still refresh.

- **Leaner marketplace package** — the `.vsix` no longer bundles internal planning and review notes, the `mcp-server` project metadata, or an unused 314 KB demo GIF. Only `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, the icons and the built `dist/` bundles ship. CI now fails if the packaged file list grows unexpectedly.
- **Releases only when something shipped changes** — docs-only, fixture-only and planning-only PRs no longer publish a new marketplace version (every release triggers a save-all + window reload for users with a canvas open).
- **Deploy resilience** — the version bump is now computed against the latest published marketplace version (so a desynced repo can no longer fail with "version already exists") and is committed and pushed *before* publishing, so a failed publish never leaves `main` behind the marketplace. The redundant duplicate production build during publish was removed.
- **CHANGELOG is maintained again** — the marketplace Changelog tab had been frozen at 0.6.27; the deploy workflow now stamps each release into this file.

### Internal

- Every domain-file write in `SemanticEditorProvider` now goes through the single `applyDomainEdit` pipeline (the 13 hand-inlined `WorkspaceEdit` copies are gone), which also releases its change-listener guard if `applyEdit` throws. New batched messages `removeAnnotations` / `removeRelationships`, and `updatePositions` carries annotation positions.
- Dead protocol surface removed: `updateViewConfig`, `runAutoLayout`, `toggleStubColumns`, `updateAnnotationPosition`, `checkManifestStaleness` (webview → host) and `domainUpdated` (host → webview) had no sender or no handler. Unused webview files `EditableColumnRow.tsx/.css`, `columnGrouping.ts` and `columnSort.ts` deleted.
- The canvas keyboard handler moved from `App.tsx` into `useCanvasShortcuts`, which reads store state at keypress time and registers its window listener once (it previously re-subscribed on every selection change via a 35-entry dependency array).
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
