# Changelog

All notable changes to the ERD Studio extension.

The `Unreleased` heading below is renamed to the released version by the deploy workflow
(`scripts/release.mjs changelog`). Add user-facing notes under it as part of each PR.

## 0.6.52 — 2026-09-12

### Added

- **Every release now has a GitHub Release, with the `.vsix` attached.** Fifty-one versions have shipped to the marketplace without ever producing a release page, so there was nothing to watch, nothing to link to and no way to install a specific version by hand. The deploy workflow now creates one from that version's changelog section immediately after a successful publish — which also means the repository gets its first tags. Watch the repository to be told when a version ships, or grab the `.vsix` from a release and install it with **Extensions: Install from VSIX…** if you need to pin or roll back.

### Changed

- **A bolder ERD Studio identity.** The extension now uses the selected Ember Alloy mark: forward-leaning ERD letterforms in bronze, silver and gold on charcoal, with the same stronger silhouette adapted to a monochrome activity-bar icon.
- **The marketplace listing now says what the extension is for.** The description led with the two-stage mechanism and never mentioned that your design is plain YAML your AI assistant can read — the thing that makes it different from every other ERD tool. The tag list has been widened to match, so searching the marketplace for dimensional modelling, Kimball, star schema, medallion architecture, analytics engineering or MCP now finds it. Marketplace **Q&A** now points at GitHub Discussions rather than a separate queue nobody was watching.

## 0.6.51 — 2026-09-08

### Changed

- **Your domain's name no longer travels with a report.** The diagnostics used to carry a line like `Domain: gold/commercial` — your own business vocabulary, naming a project the maintainer has no access to and cannot act on. It is gone, along with the layer, and not just hidden: the fields were removed from the message the dialog sends, so there is no path from a canvas to a domain name in a filed issue. What a report still says about the canvas is the part that helps: which stage was open, the schema version, and how many models and relationships it had.
- **Two model destinations instead of four.** The analysis picker now offers your editor's own model (Copilot) or the ERD Studio service, because those are the two answers to "which model reads this?". `auto` and a custom API endpoint still work if you set `erdStudio.feedback.provider` yourself, and either reappears in the picker while it is your current choice, so nobody is stranded on a destination they can no longer see.
- **The default is now your own model, and it stays put.** Fresh installs use Copilot rather than the old `auto` precedence, which quietly reached the ERD Studio service on a machine with no language model. If your editor offers no model the panel now says so and puts the ERD Studio service one click away, instead of sending your description somewhere you were never asked about.

## 0.6.50 — 2026-09-08

### Fixed

- **"…is not a registered configuration" when choosing the analysis destination.** Updating ERD Studio while VS Code is open leaves the window running the new extension code against the previous version's settings, so picking a model provider failed with a raw VS Code error that named neither the cause nor the cure. The dialog now recognises that state and asks you to reload the window, and nothing is written until it can actually be saved. If you hit this, reload the window (**Developer: Reload Window**) and pick again — or set `erdStudio.feedback.provider` in your settings directly.

## 0.6.49 — 2026-09-07

### Added

- **Send Feedback replaces Report a Bug.** One dialog now files both bugs and feature requests: pick which on the way in (or flip it later), and the labels, placeholders and GitHub issue template follow. `ERD Studio: Send Feedback` is on the command palette, the sidebar title bar, the canvas toolbar and the canvas error screen; without a canvas open it asks which kind you are filing before the title and description.
- **A straight answer about images.** GitHub accepts no image through a prefilled issue form, so the dialog offers no checkbox, capture or picker — it says once where images go, and the issue's Screenshot box is waiting empty for you to paste or drag them in when the form opens.
- **Both bug and feature, with the odds.** The analysis panel shows the split rather than only the winner — *Feature request 86% · Bug 14%* — so a near-certainty no longer looks the same as a coin toss. When it is genuinely close it says **Close call — pick one in the header** instead of quietly presenting a guess as the answer.
- **The type is chosen for you, and yours to overrule.** The dialog opens as a bug because most reports are, and the analysis moves it to a feature request as your description takes shape — the title, the labels, the placeholders and the GitHub template all follow. `Bug | Feature` sits in the header the whole time: pick one and it stays picked, and the analysis stops moving it until you hand the choice back with **auto**. With no model configured the switch is still there, so a feature request is always one click away.
- **Diagnostics you can see before you send them.** Versions, OS, the domain summary and the recent-error count are shown as chips with the exact text one click away, and a **remove** toggle if you would rather not share them. They are attached by default and are never sent anywhere until you press Submit on GitHub.
- **Copy report.** Copies the whole report — title, kind, description, steps or rationale and diagnostics — as Markdown, so it can go into an email, a chat or your own tracker instead. Works with no network, no GitHub account and no model.
- **AI assist, on by default and using your own model.** The dialog makes a single request that drafts a title, picks bug vs feature, pulls the steps out of your description and checks whether the issue has already been reported. Only what you typed is sent — diagnostics, file paths and model names never are. It uses whichever language model VS Code already offers you, so nothing new is configured and no destination of ours is involved; `erdStudio.feedback.aiAssist` turns the whole thing off. A strong match takes the dialog over and offers to add your details to the existing thread (or, when it was already fixed in a newer version, tells you to update instead of filing). Every suggestion lands in an editable field; nothing is decided for you, and a model outage never blocks a report.
- **One click to start, then nothing.** The first time your own model would be used on a machine, the panel shows a single **Analyse this for me** button ("Uses your own model. VS Code will ask once.") rather than running while you type — VS Code's access dialog should follow something you pressed. Once one analysis has come back, the panel simply keeps up with your description from then on, in that report and every future one. Dismiss VS Code's dialog and nothing breaks: the button comes back and the rest of the dialog is untouched. The same button is offered whenever the dialog opens with a description already filled in for you — the canvas error screen does that, and the text it fills in is the error itself — so nothing you did not write is ever sent without you asking for it.
- **Choose which model does the triage.** A picker in the analysis panel names every destination — Automatic, your editor's own model (Copilot), your own API endpoint, and the ERD Studio service — and switching is one click, remembered from then on. It exists because "Automatic" always tried your own model first and stopped there: if you have Copilot but would rather not spend it triaging your own bug report, you can now send it to the ERD Studio service instead (or the other way round, pinning your own model so nothing else is ever used). Destinations that cannot run on your machine are listed with the reason rather than hidden, and a pinned destination never quietly falls back to another one — if it stops working the dialog says so and leaves the picker there. Also `erdStudio.feedback.provider`, for setting it without opening the dialog.
- **AI assist settings and commands** — `erdStudio.feedback.aiAssist`, `erdStudio.feedback.provider`, `erdStudio.feedback.endpoint`, `erdStudio.feedback.model` and `erdStudio.feedback.hostedFallback`, with **ERD Studio: Set Feedback API Key** / **Clear Feedback API Key** storing the key in VS Code's secret storage, never in `settings.json`. Left on Automatic the order is your model first, then your endpoint, then the fallback below — and where none of them exists the panel is simply absent.
- **A hosted fallback, for when there is no model at all.** As a last resort the analysis can go to a small relay run by the extension author, which forwards your description to a named third-party AI provider under the author's account and that provider's terms, so the duplicate check works for people with no Copilot subscription and no endpoint of their own. It always asks first, naming **both** the relay and the provider that receives the text, and saying what leaves your machine; `erdStudio.feedback.hostedFallback: false` removes it outright. In this release that relay is **erd-studio.liam-is-an.ai**, run by the extension author, forwarding to **DeepSeek**. Nothing reaches it unless you accept the prompt, and only the text you typed is sent — never diagnostics, file paths or model names.
- **My Reports.** When you are signed in to GitHub in VS Code, a sidebar view lists the issues you filed from ERD Studio and their state — open with the comment count, implemented (with the version it shipped in, when that is known), or closed as not planned — refreshed every few hours, and one notification when something you reported ships. It is hidden entirely when you are not signed in; you are never prompted to sign in, and you can turn the whole thing off with `erdStudio.feedback.trackReports`.

### Changed

- **The canvas's top-right buttons no longer collide with the toolbar.** **Feedback** and **View File** are two labelled buttons pinned to the top-right corner, and on a laptop — or any window narrow enough, which with the sidebar open is most of them — the centred toolbar grew straight into them. They now fold into a single **⋯** menu, but only when they would actually overlap: the extension measures both, so on a wide window you keep the labelled buttons and on a narrow one you get the menu, with the switch following the toolbar as it grows and shrinks (a longer domain name, the search box, the Diff controls).

### Security

- **The feedback endpoint can only be set in your own settings.** `erdStudio.feedback.aiAssist`, `.provider`, `.endpoint`, `.model` and `.hostedFallback` are now machine-scoped and read only from your user settings, so a repository you open cannot redirect the analysis request — and the API key stored in VS Code's secret storage that goes with it — to a server of its author's choosing. The endpoint must be `https`, or `http` on localhost for a local model server. Consent is now remembered per destination, so changing the endpoint asks again rather than inheriting an answer given about a different host.

### Fixed

- **"I want a new ability to…" is no longer classified as a bug.** Every fresh dialog told the model *"The user is filing this as a bug, but decide for yourself"* — because `bug` is simply the kind the dialog opens on, not something you had chosen. The model was being handed a false fact and asked to argue with it, and it mostly agreed. Your kind is now sent only when you have actually picked one, and the model is told what separates a bug from a feature ("I want", "can you add", "a new ability to…" are feature requests however annoyed the writer sounds; a crash is a bug however politely it is worded).
- **A feature request can be filed with the AI assist off.** The kind switch is a permanent header fixture, so it is there in the default configuration where the analysis panel — which used to hold the only copy of it — never renders.
- **The readiness meter asks only for things you can actually give it.** It used to ask every report for a screenshot, which capped a feature request at 80% under a button that did nothing. The three checks left — description, steps or rationale, and diagnostics — apply to every report, so a complete one of either kind reads 100%.
- **"It still happens on my version" is no longer filed as a regression.** Clicking it from the *this is already fixed, you're on an older version* panel filed the report titled "Regression: …", against a fix the user had never received.
- **A closed issue with no recorded fix version no longer claims you already have the fix.** GitHub only tells us which release carried a fix when the issue has a milestone or a `shipped-in:` label. Without one the dialog now says so and offers **File it anyway**, instead of asserting a regression it cannot verify.
- **A regression claim can no longer attach itself to the wrong issue.** Choosing "report it as a regression" and then rewriting the description left `regressionOf` — and the "Regression: " title prefix — pointing at a duplicate that was no longer on screen.
- **A slow analysis reply can no longer take over a form you have cleared.** Deleting your description below the minimum length, or closing and reopening the dialog, now discards the reply that was still in flight.
- **The dialog no longer freezes behind a notification.** Submitting waited for a notification to be dismissed before re-enabling anything, so Cancel, Escape, the backdrop and the close button were all dead until you noticed the toast.
- **The Feedback dialog still works where GitHub sign-in is unavailable.** A host with no GitHub authentication provider made the whole context request fail, taking the diagnostics disclosure with it; only the (decorative) handle is lost now.

## 0.6.48 — 2026-09-07

### Fixed

- **Published package no longer carries deploy scratch files.** v0.6.47 shipped with `marketplace.json` (147 KB of marketplace metadata) and `vsce-show.err` inside the extension, because the deploy job wrote them next to `package.json` before packaging. They now go to the runner's temp directory, `.vscodeignore` excludes them as a second guard, and the deploy job asserts the packaged file list the same way CI does.

## 0.6.47 — 2026-09-07

### Added

- **Report a Bug** — `ERD Studio: Report a Bug` (command palette, sidebar, canvas toolbar and error screens) opens a prefilled GitHub issue with diagnostics (versions, OS, domain summary, recent errors) and, from a canvas, copies a screenshot to the clipboard for pasting. Nothing is sent until you submit on GitHub.
- **`erdStudio.claudeSync.skipPermissions` setting** (default `false`) — controls whether **Execute with Claude** launches Claude Code with `--dangerously-skip-permissions`. Previously that flag was always passed with no way to turn it off and no warning; the launch is now confirmed in a modal that names the flags first.

### Fixed

- **Creating or renaming a model no longer overwrites someone else's model file** — the `logical-models/` library is shared by every domain, so "New Model" and "Rename Model" could silently replace an existing `logical-models/<name>.yml` (and everything in it) when the name was already taken elsewhere. Both now refuse the name and tell you which file already exists.
- **Undo restores the model file with the domain file** — a column, grain, role or rationale change writes `logical-models/*.yml` and the domain `.json`; the yml was written outside VS Code's undo stack, so one Cmd+Z rewound the domain and left the yml edited. They are now a single edit and a single undo step, and a rejected edit leaves both files untouched.
- **Harness files are never overwritten without asking** — installed AI harness files (`CLAUDE.md`, `AGENTS.md`, Copilot instructions, Gemini styleguide) used to be rewritten on activation whenever ERD Studio's schema version moved on. Out-of-date files now raise a prompt offering **Update All**, **Choose…** or **Dismiss**, and in `AGENTS.md` only the region between the ERD Studio markers is replaced — anything you wrote around it is preserved.
- **The physical stage shows models that are only in the manifest** — a model with no entry in a schema `.yml` was dropped from the physical diagram entirely, even when dbt clearly knew about it. Each model is now resolved from yml first and falls back to the manifest on its own, so it appears either way (and relationships come from the tests declared in both sources).
- **Model and column names now match across stages regardless of case** — `DIM_CUSTOMER` in the manifest and `dim_customer` in your logical design are recognised as the same thing, so the physical stage renders and the discrepancy report no longer reports the whole model as both "missing" and "extra". Names are still displayed exactly as they are written.
- **An error no longer throws away the diagram you were looking at** — a failed action used to replace the whole canvas with an error page, losing selection, zoom and pan. Errors now appear as a dismissable toast over the live canvas; the full-screen page (with Retry and Report a Bug) is reserved for a domain that fails to load at all.
- **`?` can be typed in text fields again** — the Shift+? legend shortcut fired while you were typing in a name, description or note, so the character never reached the input (and the legend flew open). Canvas shortcuts are now ignored whenever focus is in a text field.
- **SCD and additive types survive an inline column edit** — renaming a column or changing its data type on the canvas silently cleared that column's SCD type and additive type. Inline edits now leave fields they do not touch alone.
- **Reporting a bug from a hidden canvas no longer hangs** — the screenshot capture never completed when the editor tab was in the background; it now gives up after a short timeout and the bug report is submitted without the image instead of waiting forever.
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
- Runtime dependencies: `js-yaml` and `@types/js-yaml` removed (model YAML is now parsed with the `yaml` package's document API so comments and key order survive edits), and `yaml` bumped `^2.8.2` → `^2.9.0` to clear its published advisory. CI now runs `npm audit --omit=dev --audit-level=high` for both the extension and `mcp-server`.

## 0.6.27 — 2026-04-21

### Added

- **Inline column delete on the canvas** — hover any column on a model node to reveal a one-click delete button. Deleting a column also cascades to any relationships that referenced it, matching the existing behaviour for deleted models.

### Fixed

- **Self-reference relationships** (a model linking to itself) now render as a proper cubic-bezier loop arcing over the top-right corner of the node, instead of collapsing into the node body.
- **Double-click to add note** is now detected reliably across the entire canvas. The previous check silently dropped the gesture whenever the click target wasn't the exact React Flow pane element (for example, when an overlay or child element intercepted it). The "New Note" dropdown item also now advertises the gesture via tooltip.
- **Marketplace README** — header icon, demo GIF, and license badge now render correctly on the extension page. Images are served from a public assets repo (the source repo remains private) and the license badge is a static MIT badge.
