# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**ERD Studio** (package `erd-studio`, publisher `liamwynne`) is a VS Code extension for logical data modelling in Git: entity-relationship diagrams stored as **DBML, an open format**, that the user's own AI assistant can read and write (projects from before 2.0 keep their YAML/JSON, still read and edited, and **Convert Project to DBML** moves one over), with DBML import and export. A **logical** stage is the editable design and works in any folder; when the open folder is a dbt project, a **physical** stage is derived at runtime from it and is read-only (without `dbt_project.yml` the editor is logical-only and the Physical tab is hidden). The repo ships three things: the extension, a read-only `erd-studio` CLI (`dist/cli.js`), and two npm packages (`@erd-studio/core`, `@erd-studio/renderer`) consumed by the paid **ERD Studio for Confluence** app.

## Read before touching

| If you are changing… | Read first |
|---|---|
| Model library folders, `name` vs `alias`, relationships (library storage, orientation, composites, Move, rename cascade) | `docs/dev/relationships.md` |
| Settings (every one, with defaults), data flow, physical-stage derivation, custom editor, message protocol, edit pipeline, activation, watchers, discrepancies | `docs/dev/architecture.md` |
| Anything under `packages/` (core pipeline, exporters, renderer, viewer mode) | `packages/CLAUDE.md` |
| The Confluence app, its cache and what old files must still render | `docs/dev/compatibility.md` |
| Send Feedback (dialog, AI analysis tiers, consent, redaction, My Reports) | `docs/dev/feedback.md` |
| Usage telemetry (extension side and the Worker) | `telemetry/README.md` |
| Getting Started panel, CLI launcher, the `erd-studio` CLI | `docs/dev/onboarding-and-cli.md` |
| The README or a user guide (`docs/dbt.md`, `docs/ai-assistants.md`, `docs/project-folder.md`), Marketplace copy, walkthrough or welcome-view text | the wording rules in `docs/dev/onboarding-and-cli.md` |
| DBML storage, import and export: `packages/core/src/dbml/`, the subject-area codec, `planDbmlLibraryWrites`, `applyFileWrites`, Convert Project to DBML, the rich export, the `.dbdiagram` layout file, Export All Diagrams, Import DBML (parser pin, property names, `meta.dbml`) | `docs/dev/dbml.md` |
| Native DBML storage: the decisions (D1–D25), the normative format, the stages and their review log | `docs/plans/native-dbml-storage.md` |
| `SCHEMA_CONTENT`, harness generators, the `/erd-studio-setup` skill | `src/harness/CLAUDE.md` |
| Releases, package publishing, manual publish | `docs/dev/releasing.md` |
| Rendering the webview in Chrome | `docs/dev/webview-preview.md` |
| The on-disk file format (DBML tables, relationships and diagrams, the `.dbdiagram` layout; legacy domain JSON and model yml; `layers.json`) | `docs/semantic-domain-json-reference.md` |
| `proxy/`, `telemetry/`, `video/` | their own `README.md` |

`test/unit/claudeMdPointers.test.ts` fails if a path in this table stops existing — update the table when you move a doc.

## Directory structure

ERD Studio uses a **central table library** shared by every diagram. **New projects store it as DBML** (native DBML storage, ERD Studio 2.0, `CURRENT_SCHEMA_VERSION` 7; spec `docs/plans/native-dbml-storage.md`): one `.dbml` file per table in `.erd-studio/tables/`, at the top level or exactly one folder down; each folder's relationships as `Ref` lines in its `_relationships.dbml`; each diagram as `.erd-studio/{layer}/{name}.dbml` whose `use` lines name its tables, with its positions in a `.dbdiagram` file beside it. **Projects from before 2.0 keep YAML/JSON** (domain schema v4–v6, below), still read and fully edited; nothing converts unless the user runs `erdStudio.convertProjectToDbml`. The custom editor activates for `**/.erd-studio/*/*.json`, `**/.erd-studio/*/*.dbml` (a `file:` `.dbml` that is not a diagram is rerouted to the text editor) and the pre-0.6.44 `**/erd-studio/*/*.json` (which activation renames). The base directory is the `erdStudio.semanticDir` setting (default `.erd-studio`).

```
.erd-studio/
├── layers.json                    ← JSON, unchanged
├── templates/*.json               ← JSON, unchanged
├── tables/                        ← the table library (never a layer in a DBML project)
│   ├── dim_date.dbml              ← one Table per file, named exactly as the table
│   ├── _relationships.dbml        ← Refs owned by top-level tables
│   └── gold/                      ← optional folder, one level only
│       ├── fct_order.dbml
│       └── _relationships.dbml    ← Refs owned by tables in tables/gold/
└── gold/
    ├── sales.dbml                 ← diagram: Project + `use` lines + sticky Notes
    └── sales.dbdiagram            ← its layout (positions); absent until something is placed
```

- **One detector each; never add a second.** `detectSubjectAreaFormat()` (`packages/core/src/types/semantic.ts`) for a JSON diagram, `detectProjectStorage()` (same file; host `projectStorageOf()` in `src/services/projectStorage.ts`) for what a project writes — `dbml` (also an empty project), `yaml` or `mixed`, decided by library evidence only — and `classifySemanticFile()` (`packages/core/src/storage.ts`) for what a path under the semantic dir is (diagram, table, relationships, layout, …).
- **DBML rules** (D2–D5): table names are unqualified (`Table fct_order [schema: 'gold']`), the stem equals the declared name (compared without case on read), and `_relationships` is reserved only for new `.dbml` tables. A relationship belongs to its FK table and is one Ref in **that table's folder's** `_relationships.dbml`; a Ref found elsewhere is *misplaced* (drawn, warned, moved home by the next write to its owner). A diagram's members are the stems of its table `use` lines, resolved **by name** (`tableFileCandidates`), never by trusting the path. DBML diagrams hold no Refs: every relationship edit on one uses `home = 'library'`. In a mixed project a DBML diagram or DBML-owned Ref may name only DBML tables (D20).

The legacy YAML/JSON layout (domain schema v5/v6): one model yml per table in `logical-models/` (or v6's `tables/`), domain JSON files at `{layer}/{domain}.json` referencing models by name and holding relationships plus canvas layout:

```
.erd-studio/
├── logical-models/          ← one YAML per model, shared across domains
│   ├── dim_customer.yml     ← top level (flat libraries keep working)
│   └── gold/fct_order.yml   ← optional per-layer folder (one level only)
├── silver/customer-360.json ← domain file: logical.models = ["dim_customer", …]
└── gold/reporting.json
```

- **A model's `name` is its identity everywhere** (domain `logical.models`, relationship endpoints, `viewConfig.positions` keys, physical matching) and is unique across the whole library, case-insensitively. Never make a folder part of it. `alias` is the warehouse table name (dbt's `alias`). Folders are organisational only and **opt-in per project** (`TableLibraryService.groupsByFolder()`); a flat library stays flat.
- **Relationships are defined once, in the model library**, stored in the many (FK) side's file (`canonicalRelationship()`; in DBML, that table's folder `_relationships.dbml`). Link identity is core's `linkKey` / `sameLink` only; direction comes from `orientLink`, and when nothing decides it the dialog asks — never default from drag order. **Every canvas relationship edit is planned by the pure `planRelationshipWrite`** (the exhaustive checker in `test/unit/relationshipStateSpace.*` calls the same function); never write a second planner. Composite FKs are one entry per column pair sharing `compositeKey`, never an array. Library storage is opt-in per project by what is on disk (`usesLibraryRelationships`). Details: `docs/dev/relationships.md`.
- **Format detection** is `detectSubjectAreaFormat()` (`packages/core/src/types/semantic.ts`) → `v6` | `v5` | `v4` (loads, prompts for `erdStudio.migrateToV5`) | `hybrid` / `legacy` (rejected). Never add a second detector.
- **Legacy YAML rule — schema v6, the table naming** (#181 reads it, #182 writes it): `tables/`, `logical.tables`, `subjectArea`, `fromTable`/`toTable`, `tableRole`, `linkedTable`. `validateSubjectAreaDocument` normalises a v6 file to the v5 keys (`normaliseSubjectAreaDocument`) and model yml is normalised by key in `parseTableText`, so nothing downstream branches on the naming; never add a second normaliser. **Writes go back through one boundary per file type**: `SemanticEditorProvider.parseSubjectAreaDocument` remembers a v6 document and `serialiseSubjectArea` writes it back with core's `toTableNamingDocument` (the order-preserving inverse); `TableLibraryService.renderTable` renames a `tables/` (or v6-keyed) yml's keys to v5 for the edit and back to v6 after. Every edit keeps its file's naming; new files follow `projectNamingOf()` (`src/services/projectNaming.ts`, core's `detectProjectNaming()` fed from disk — the single answer, shared by the canvas, commands, the offer and `doctor`): `v5` writes `logical-models/` and v5 keys, `v6` / `mixed` write `tables/` and v6 — in a project whose storage is `yaml`; a project with no library yet writes DBML. `CURRENT_JSON_SCHEMA_VERSION` (6) is the JSON read ceiling (`CURRENT_SCHEMA_VERSION`, 7, covers DBML's `erd_schema_version`). The migration is the pure `planNamingMigration` (`src/services/namingMigration.ts`), applied by `erdStudio.migrateToTableNaming` as one `WorkspaceEdit` (yml moved by file operations only) and previewed by `doctor`; never write a second planner. `TableLibraryService` reads `logical-models/` then `tables/` (a name in both is a reported conflict); `tables/` is a layer folder, not the library, when `tablesDirIsLayer()`.

## Build & test

```bash
npm run build          # extension, webview, manifest-worker and CLI bundles (esbuild)
npm run watch          # rebuild on change
npm run compile        # type-check only (both tsconfigs)
npm run test           # vitest (root + packages/*/test/unit)
npm run package        # production build
npm run build:packages # publishable dist/ of both packages
```

- Single test: `npx vitest run test/unit/domainService.test.ts`
- CLI against a fixture (after a build): `node dist/cli.js doctor --project test/fixtures/dbt-project --no-dbt` (also `diff --all`, `inventory --summary`, `export`, `--json`)
- Dev host: `npm run build && code --extensionDevelopmentPath=/Users/liamwynne/GIT/LIAM/erd-studio /Users/liamwynne/GIT/LIAM/erd-studio/test/fixtures/dbt-project` — open the **showcase** domain for the richest data. (F5 also works; it runs the `npm: watch` task.)
- Tests alias `vscode` to the stateful mock `test/__mocks__/vscode.ts`. Fixture dbt projects live in `test/fixtures/` (`dbt-project` is the main one).
- CI (`.github/workflows/ci.yml`) also runs a CLI smoke test, `npm pack --dry-run`, the `mcp-server/` build and the telemetry Worker checks, and fails if the VSIX exceeds 60 files.

## Architecture map

Four esbuild targets (`esbuild.js`, each in both build and watch branches):

| Target | Source → output | Notes |
|---|---|---|
| Extension host | `src/` → `dist/extension.js` | Node, CJS |
| Webview | `webview/` → `dist/webview.js` + `.css` | browser IIFE, React; ELK worker injected via `define` (`importScripts()` is unavailable in webviews) |
| Manifest worker | `src/workers/manifestWorker.ts` → `dist/manifestWorker.js` | worker thread, plain `JSON.parse` |
| CLI | `src/cli/index.ts` → `dist/cli.js` | Node 18, **no `external`**: an `import 'vscode'` anywhere in its graph breaks the build (`test/unit/cli.noVscode.test.ts`) |

- Two tsconfigs: `tsconfig.json` (Node) and `tsconfig.webview.json` (DOM, includes `src/types/**`). `@types/vscode` is pinned to `1.85.0` to match `engines.vscode` — **use no newer VS Code APIs**.
- **Packages are built from source** in the extension: tsconfig `paths` and vitest aliases point `@erd-studio/core` / `@erd-studio/renderer` at `packages/*/src`; their `exports` point only at `dist/`. Core owns the pure raw-files → `DisplaySubjectArea` pipeline and the Mermaid / DBML exporters; host services delegate to it and keep only file access, caching and messaging. The renderer owns the canvas; its components post edits through `CanvasHost`, never `acquireVsCodeApi()`.
- `src/` layout: `extension.ts` (activation), `providers/` (`SemanticEditorProvider` custom editor, `GettingStartedPanel`, tree views, `payloadValidation.ts`), `services/` (business logic), `commands/`, `watchers/`, `cli/`, `harness/` (setup-skill markdown, inlined at build), `workers/`, `types/` (shared host + webview; never imports from `services/`).
- `webview/`: the editor around the renderer canvas — `components/`, `store/editorStore.ts` (Zustand; its `setDomain` override must stay last in the initialiser), `hooks/` (`useMessageBus`, `useSend()`), `host/vscodeCanvasHost.ts`, `lib/elkLayout`.
- **Not build targets:** `proxy/` (feedback analysis Worker), `telemetry/` (telemetry Worker, deployed by `deploy.yml`), `video/` (getting-started video pipeline), `mcp-server/`. Nothing in `esbuild.js`, the tsconfigs, vitest or the npm scripts may depend on `proxy/`, `telemetry/` or `video/`; `npm run build` and `npm test` must pass in a clone that never touched them.

### Two stages

| Stage | Colour | Purpose | Storage |
|---|---|---|---|
| **Logical** | Blue `#60a5fa` | Full design — columns, types, PK/FK/NK, SCD, grain, rationale | DBML: `tables/**.dbml` + `_relationships.dbml` + the diagram's `.dbml` / `.dbdiagram`; legacy: `logical-models/**.yml` (or v6 `tables/**.yml`) + the domain file's `logical` section |
| **Physical** | Green `#22c55e` | What exists in the dbt project (source files, schema yml, `manifest.json`, `catalog.json`); relationships derived from dbt relationship tests | Derived at runtime, **never persisted** |

### Data flow

```
{layer}/{domain}.dbml|.json ─┐   (subjectAreaCodec: DBML or JSON)
tables/**.dbml + _relationships.dbml, logical-models/**.yml ─┴→ SubjectAreaService.getSubjectArea() ─→ UnifiedSubjectArea ─→ .logical → DisplaySubjectArea
schema .yml + source files ─→ YmlParserService ─┐                                         │
manifest.json              ─→ ManifestService  ─┼→ buildPhysicalSubjectArea() ─→ DisplaySubjectArea │
catalog.json               ─→ CatalogService   ─┘                                         │
                                                    [message] ─→ graphTransformer ─→ React Flow
```

The canvas and the CLI reach comparisons through the same pure cores — `buildLogicalDisplaySubjectArea` (`stageDisplay.ts`), `computeSubjectAreaDiff` (`stageDiff.ts`) and `buildSyncPlan` / `allSelections` (`syncPlanBuilder.ts`). **Never write comparison logic anywhere else**, or the two will disagree. Full step-by-step (existence, column / type / description precedence, provenance, discrepancy statuses): `docs/dev/architecture.md`.

## Rules

### Edit pipeline

- **Every canvas write to a diagram file, a table file (`.dbml` or `.yml`) or a relationships file goes through `applySubjectAreaEdit` / `applyTableEdit`** in `SemanticEditorProvider`: one `WorkspaceEdit`, one save, one undo step, nothing on disk unless `applyEdit` succeeds. Never `fs.writeFileSync` or hand-roll a `WorkspaceEdit` in a provider handler. (Direct `fs` writes elsewhere — `LayerService.saveConfig`, `HarnessService`, `MigrationService`, `moveRelationshipsToLibrary`, … — are not the editor path.)
- After `applyEdit`, save model documents with `saveDocumentByUri` (`src/providers/documentSave.ts`) and check the result: `save()` resolves `false` rather than throwing.
- Any writer of a watched file (a diagram `.json` / `.dbml` / `.dbdiagram`, `layers.json`, a table `.yml` / `.dbml`, a `_relationships.dbml`) records `ownWrites` **after** the bytes land.
- **DBML writes splice by parser node offsets** (`packages/core/src/dbml/`); a no-op save is byte-identical; a file that does not parse is refused, never regenerated. `planDbmlLibraryWrites` (`src/services/dbmlLibraryWrites.ts`) only places tables and Refs in files — `planRelationshipWrite` still decides the relationships. Every edit that creates or deletes files goes through `applyFileWrites` (`src/providers/applyFileWrites.ts`), which reconciles when `applyEdit` returns `false`.
- Model yml writes (legacy files) edit the parsed YAML document in place, so comments, key order, unknown keys, number text and aliases survive. Never regenerate a file that parses.
- Refresh paths (watchers, external edits, stage switches) never write. Only the initial `ready` load persists auto-computed positions, and only for a partially positioned domain.
- Compare model and column names with `sameName()` / `normaliseName()` (case-insensitive). Names match `TABLE_NAME_PATTERN` / `COLUMN_NAME_PATTERN` (`src/types/naming.ts`; the renderer keeps its own copies). Refuse a case-only model rename (the write-new + delete-old edit would delete the file on macOS/Windows). Add / Rename refuse a name already in the domain or the library in any case via `TableLibraryService.findTableNameIgnoringCase`, which lists files — never `existsSync`, which is case-sensitive on Linux.
- `updateColumn` treats an omitted `scdType` / `additiveType` as "keep" and `null` as "clear".
- `meta` is the user's free-form map: edit only through `updateMeta` patches; it is never compared, diffed or synced to dbt. `TableLibraryService.syncMeta` writes only the top-level key that changed, matching keys as the parser reads them (never via `YAMLMap.get/set`).
- `SelectorsService` owns only `domain_*` selectors whose description ends with `Managed by ERD Studio.`; everything else in `selectors.yml` is preserved.

### Message protocol and the physical stage

- Every message type in `src/types/messages.ts` has a live sender, a handler and payload validation in `src/providers/payloadValidation.ts`; update both unions. Unknown types reach the `default:` branch and are logged. Multi-select operations are batched into one `WorkspaceEdit`.
- **The physical stage is read-only.** The allowlist is `NON_MUTATION_TYPES` in `SemanticEditorProvider.ts`: never add a schema mutation to it, and keep `undo` / `redo` off it (they would rewind the logical document under a derived view). Never persist physical data or copy logical relationships into it.

### Confluence and backward compatibility

The Confluence app renders whatever is committed in a customer's repo — written by any extension version — and cannot run a migration. So:

- **Every change under `packages/` ships automatically** to npm on merge to `main` and into the Confluence app. Every export, the `ErdCanvas` props, the `DisplaySubjectArea` shape, the `loadDisplaySubjectArea` options and its four error classes, and the README's `--vscode-*` list are a public contract. A breaking change is a pinned MINOR while `0.x`; say in the PR if the Confluence cache key needs a bump.
- **Never drop a read path.** Core keeps loading DBML projects (through the `@erd-studio/core/dbml` subpath's `dbmlStorageReader`), v4, v5 and v6, flat and foldered libraries, relationships in the domain file, the library or both, `one-to-many` records, and a missing `layers.json`. Format changes are additive on read.
- **New fields are optional** (domain JSON, model yml, `layers.json`, `Display*` types) with a default that renders what an older file meant; the renderer must draw a `DisplaySubjectArea` from an older core. A field whose meaning changes gets a new name.
- **Unknown keys are ignored, not rejected.** Only a newer `schemaVersion` (or a DBML diagram's newer `erd_schema_version`) may refuse a file.
- Before changing how a format is written, add a fixture and golden of the old shape under `packages/core/test/fixtures/`. Never delete an old-format golden; regenerate one (`UPDATE_GOLDEN=1`) only for an intended rendering change. Keep a "still read" note in `docs/semantic-domain-json-reference.md`.
- The viewer path (`ErdCanvas` with `viewer`) makes no `CanvasHost` posts, touches no VS Code globals and shows no editing affordance. Write every viewer gate as `viewer ? … : <upstream>`.
- Exporter output (Mermaid / DBML) is a contract that must parse in every pinned parser; a mapping change is a golden update plus a CHANGELOG line. Details in `packages/CLAUDE.md`.
- Core may not import Node built-ins, `vscode`, React or React Flow (`test/unit/packagesBoundary.test.ts`).
- Code flows public → private only: never copy anything from `liam-machine/erd-studio-pro` into this repo.

### Identifiers and settings

- All identifiers use the `erdStudio` prefix (`erd-studio` for the activity bar container; palette category `"ERD Studio"`).
- **Never remove the `dbtSemantic` compatibility shims.** Pre-rename commands are also registered in code as `dbtSemantic.*` (`LEGACY_ALIASED_COMMANDS`, end of `activate()`) — never contribute those in `package.json`. Add every **new** command to `NO_LEGACY_ALIAS` in `src/extension.ts`. `PRE_REGISTERED_COMMANDS` are registered before the no-project early return; never register one twice. The deprecated `dbtSemantic.projectPath` / `.semanticDir` settings stay contributed.
- **Read settings only through `getErdStudioSetting()`** (`src/services/configService.ts`), never `getConfiguration('erdStudio').get(...)`.
- The `erdStudio.feedback.*` AI settings, `erdStudio.telemetry.enabled` and `erdStudio.checkKnownFixes` are `"scope": "machine"` **and** listed in `USER_SCOPED_SETTINGS`. Never remove either half: a checked-in `.vscode/settings.json` must not be able to redirect the analysis request (and the API key that travels with it) or flip telemetry or the known-fixes check.

### Security and privacy — do not "fix" these

- **Feedback:** no image capture, picker, drop zone or paste-to-attach route (GitHub cannot accept one; `FEEDBACK_IMAGE_NOTE` is the whole Images section). `FeedbackSubjectAreaSummary` carries no domain name or layer. Keep every `redactPaths()` call site. Diagnostics are never sent to the model. Never auto-analyse text the user did not write. A pinned analysis provider never falls through to another tier. Never write `vscode.lm.` directly (use `getLanguageModelApi()`). `HOSTED_ANALYSIS_ENDPOINT` and `HOSTED_ANALYSIS_PROVIDER` change together, in one commit.
- **Telemetry:** no field may hold a name, path or message. `installId` is `crypto.randomUUID()`, never `vscode.env.machineId`. The contract with the Worker is additive (`HEARTBEAT_VERSION` stays `1`); change both sides and `telemetry.json` in one PR and deploy the Worker first. The root README never mentions telemetry.
- **Harness hook:** the PreToolUse hook only ever denies; never add an allow path.
- **dbt:** never run a project-venv dbt that `PATH` does not resolve to without `--trust-venv`; keep the skill's pre-approved dbt rules subcommand-scoped.
- **CLI:** read-only (`doctor`, `inventory`, `diff`, `export`, `version`). Never add a writing subcommand or an `--out` flag; assistants write `.erd-studio` files with Edit/Write so the writes stay visible.
- **No unprompted writes on activation**, apart from the legacy `erd-studio/` → `.erd-studio/` rename and refreshing `~/.erd-studio-cli` when `launcher.json` already exists. Only **Set Up My AI Helper** installs the launcher.
- Getting Started panel URLs come from fixed constants, never from the webview; its CSP stays nonce-only.
- Keep `vscode` out of worker-shared, mcp-server-shared and CLI-bundled modules (`nameUtils`, `manifestExtractor`, and every service `dist/cli.js` bundles).
- The getting-started video's audio is MP3, never AAC (VS Code's ffmpeg has no AAC decoder). The README links only the AAC copy in `docs/assets/`.

### Harness

- **A schema change must update the harness:** changing the on-disk schema (`packages/core/src/types/semantic.ts`, the DBML codec under `packages/core/src/dbml/` and `dbmlRichProperties.ts`, file layout, naming conventions) means updating `SCHEMA_CONTENT` (and the generators if needed) in `src/services/harnessService.ts`, **bumping `HARNESS_VERSION`**, and updating `docs/semantic-domain-json-reference.md`. Don't bump it for unrelated changes. Never silently overwrite a harness file that has no version marker. Never gitignore `.agents/`. Read `src/harness/CLAUDE.md` before editing `src/services/harnessService.ts` — it does not load on its own for files outside `src/harness/`.

### Webview

- BEM class names; colours only from the CSS custom properties in `packages/renderer/src/styles/theme.css`; React Flow node and edge type maps are module-level constants; `useSend()` rather than `useMessageBus(() => {})`.
- Host `error` messages are a dismissable toast over a live canvas; the full-screen error page is for initial-load failure only.

## Releasing

- **Every extension release is a PATCH bump unless Liam explicitly asks for a minor or major.** Leave the changelog heading as a bare `## Unreleased`; pin a version (`## Unreleased — 1.7.0`) only on an explicit request. If a change looks breaking (dropping a `schemaVersion`, removing commands or settings, raising `engines.vscode`, changing the on-disk layout), say so in your reply and still ship it as a patch unless he says otherwise.
- Put user-facing notes under `## Unreleased` in `CHANGELOG.md` in every PR (`### Added` / `### Changed` / `### Fixed` / `### Removed`). Never edit the root `version` by hand — `deploy.yml` owns it.
- Packages publish automatically on merge to `main` (patch by default). For a MINOR (a breaking change while `0.x`), set the new version in the PR: the package's `package.json`, the renderer's exact `@erd-studio/core` pin, the root dependencies, then `npm install`. Never unpublish or overwrite an npm version; fix forward.
- Edit `deploy.yml`'s `paths-ignore` and its `changes` filter together (`test/unit/deployWorkflow.test.ts`).
- Opt-in pre-releases go through `prerelease.yml` (manual: `ref` + `version` between the latest stable and the ref's pinned stable, e.g. 1.9.0 before 2.0.0); it never commits a version, and the stable deploy ignores pre-release versions. See `docs/dev/releasing.md` → "Pre-releases (opt-in)".
- Mechanics, manual publishing and PATs: `docs/dev/releasing.md`.

## Code review checklist

Rules reviewers (human or AI) apply to every PR:

- Domain/model writes go through `applySubjectAreaEdit` / `applyTableEdit` (file creates and deletes through `applyFileWrites`) — reject hand-rolled `WorkspaceEdit`s or direct `fs` writes in the provider; DBML writes splice, never regenerate a file
- Physical stage is derived at runtime: reject code that persists physical data, copies logical relationships into physical, or extends the physical allowlist with schema mutations
- Message protocol changes update both directions in `src/types/messages.ts`, add payload validation, and wire both a sender and a handler
- Schema changes update `SCHEMA_CONTENT`, bump `HARNESS_VERSION` and update the reference doc
- `erdStudio` identifiers only; the `dbtSemantic` aliases and deprecated settings stay; settings read via `getErdStudioSetting()`
- No `vscode` imports in worker-shared or CLI-bundled modules; no APIs newer than VS Code 1.85
- No comparison logic outside `computeSubjectAreaDiff` / `buildSyncPlan` — the canvas and the CLI must share one diff
- Old files keep rendering: reject a change to `@erd-studio/core` that stops reading an on-disk shape a released extension wrote, a new field without a default for its absence, an unknown key that now fails validation, or a renderer change that requires a `DisplaySubjectArea` field older cores did not produce. A package API break must be a pinned MINOR (while `0.x`), never an automatic patch
- Webview: BEM classes, theme CSS variables (no hardcoded colours), module-level node/edge type maps, `useSend()` rather than `useMessageBus(() => {})`
- Skip: lock-file formatting, `test/fixtures/` sample data, deploy-workflow version bump commits
