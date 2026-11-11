# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**ERD Studio** (package `erd-studio`, publisher `liamwynne`) is a VS Code extension for logical data modelling in Git: entity-relationship diagrams stored as **DBML, an open format**, that the user's own AI assistant can read and write (projects from before 2.0 keep their YAML/JSON, still read and edited, and **Convert Project to DBML** moves one over), with DBML import and export. A **logical** stage is the editable design and works in any folder; when the open folder is a dbt project, a **physical** stage is derived at runtime from it and is read-only (without `dbt_project.yml` the editor is logical-only and the Physical tab is hidden). **dbt is an add-on and shows up only in dbt projects:** a folder without `dbt_project.yml`, or an empty window, shows no dbt control and no dbt wording (`test/unit/dbtAddonSurfaces.test.tsx` sweeps every surface); gate a dbt variant on `erdStudio.hasDbtProject` / `logicalOnly` rather than deleting it. The repo ships three things: the extension, a read-only `erd-studio` CLI (`dist/cli.js`), and two npm packages (`@erd-studio/core`, `@erd-studio/renderer`) consumed by the paid **ERD Studio for Confluence** app.

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
| The onboarding guide, Show Me Around (coach marks on the draft and the canvas, `src/types/onboardingGuide.ts`) | `docs/dev/onboarding-and-cli.md` → Show Me Around |
| The Draft-first start: the draft preview (`src/providers/DraftPreviewPanel.ts`, `webview-draft/`), the draft services (`src/services/draft*.ts`), `src/types/draft.ts`, the automatic draft on the empty Diagrams view, the start suggestion, or any import's dry run (now the draft) | `docs/dev/draft-first.md` |
| The README or a user guide (`docs/dbt.md`, `docs/faq.md`, `docs/ai-assistants.md`, `docs/project-folder.md`, `docs/modelling-patterns.md`, `docs/import-existing-models.md`), Marketplace copy, walkthrough or welcome-view text | the wording rules in `docs/dev/onboarding-and-cli.md` |
| DBML storage, import and export: `packages/core/src/dbml/`, the subject-area codec, `planDbmlLibraryWrites`, `applyFileWrites`, Convert Project to DBML, the `erd_layout` codec, Ref placement and diagram imports, the rich export, Export All Diagrams, Import DBML (parser pin, property names, `meta.dbml`) | `docs/dev/dbml.md` |
| The generated (fast-check) tests of the importers and the DBML round trip, `FC_RUNS` | `docs/dev/generated-tests.md` |
| Native DBML storage: the decisions (D1–D33), the normative format, the stages and their review log | `docs/plans/native-dbml-storage.md` |
| `SCHEMA_CONTENT`, harness generators, the `/erd-studio-setup` skill | `src/harness/CLAUDE.md` |
| Releases, package publishing, manual publish | `docs/dev/releasing.md` |
| Rendering the webview in Chrome | `docs/dev/webview-preview.md` |
| The real-world import samples' truth, or the database read-back that checks it | `docs/dev/real-world-truth.md` |
| The import corpus (the large set of pinned public schemas: fetch, counter, scorer, round trip, the manual `import-corpus.yml`) | `scripts/corpus/README.md` |
| The onboarding stories in `test/stories/` (user stories as code driving a real VS Code, filmed as captioned videos; `npm run stories`, `stories.yml`), or any first-run surface they cover (start links, walkthrough, empty Diagrams view, Open an Example) | `docs/dev/onboarding-stories.md` |
| The on-disk file format (DBML tables, relationships and diagrams, `erd_layout`; legacy domain JSON and model yml; `layers.json`; `fields.yml`) | `docs/semantic-domain-json-reference.md` |
| Context fields: the field catalogue and `fields.yml` (`packages/core/src/fields.ts`, `fieldsFile.ts`, `src/services/fieldsService.ts`), how a field is spelled in a table file (bare `<key>`, old `rationale_` / `meta_` / `meta_json`, reserved names), the Detail panel's Fields section, `doctor`'s `erd.fields`, the skill's Fields section | `docs/dev/fields.md` |
| The example projects in `docs/examples/` (one per modelling pattern, the shapes customers' repos take) and their tests — see **Example projects** under Rules | `docs/modelling-patterns.md` |
| `proxy/`, `telemetry/`, `video/` | their own `README.md` |

`test/unit/claudeMdPointers.test.ts` fails if a path in this table stops existing — update the table when you move a doc.

## Directory structure

ERD Studio uses a **central table library** shared by every diagram. **New projects store it as DBML** (native DBML storage, ERD Studio 2.0, `CURRENT_SCHEMA_VERSION` 7; spec `docs/plans/native-dbml-storage.md`): every file under a **layer folder**: one `.dbml` file per table in `{layer}/tables/{schema}/` (declaring `Table {schema}.{name}`), the relationships as `Ref` lines in `{layer}/relationships/*.dbml` files, and each diagram as `{layer}/diagrams/{name}.dbml`, whose `use` lines name its tables and the relationships files it imports, with its positions in its `Project`'s `erd_layout`. The kind of a file comes from its path alone. The 1.9 pre-release tree (`tables/**`, `<layer>/x.dbml` + `.dbdiagram`) is recognised and never read (`legacyDbmlTree`). **Projects from before 2.0 keep YAML/JSON** (domain schema v4–v6, below), still read and fully edited; nothing converts unless the user runs `erdStudio.convertProjectToDbml`. The custom editor activates for `**/.erd-studio/*/*.json`, `**/.erd-studio/*/diagrams/*.dbml` (a `.dbml` that is not a diagram gets the not-a-diagram page, never a reroute) and the pre-0.6.44 `**/erd-studio/*/*.json` (which activation renames). The base directory is the `erdStudio.semanticDir` setting (default `.erd-studio`).

```
.erd-studio/
├── README.md                      ← explains the folders; only ever created
├── layers.json                    ← JSON, unchanged
├── fields.yml                     ← optional: the fields the project records (ERD Studio only reads it)
├── templates/*.json               ← JSON, unchanged
└── gold/                          ← a layer folder (a lower-case layer id; its label is in layers.json)
    ├── tables/gold/fct_order.dbml ← one Table per file: Table gold.fct_order (schema folder = qualifier)
    ├── relationships/gold.dbml    ← Refs only; the layer's default file (teams may split it)
    └── diagrams/sales.dbml        ← use lines + sticky Notes + Project last (positions in erd_layout)
```

- **One detector each; never add a second.** `detectSubjectAreaFormat()` (`packages/core/src/types/semantic.ts`) for a JSON diagram, `detectProjectStorage()` (same file; host `projectStorageOf()` in `src/services/projectStorage.ts`) for what a project writes — `dbml` (also an empty project), `yaml` or `mixed`, decided by library evidence only — and `classifySemanticFile()` (`packages/core/src/storage.ts`) for what a path under the semantic dir is (diagram, table, relationships, readme, …; `legacy` for a 1.9 shape).
- **DBML rules** (D28–D33): a table file declares `Table <schema>.<name>`, the qualifier spelled once as its schema folder (`schemaAsListed`); the stem equals the name (compared without case on read); names stay unique across every layer and schema. A relationship belongs to its FK table and is one Ref, stored once, in any `{layer}/relationships/` file: a **new** Ref goes to the file already holding the most Refs of its FK table, else `<FK layer>/relationships/<FK layer>.dbml` (`placeNewRef`); an existing Ref is never moved. A diagram imports **exactly** the relationships files holding a Ref (or a pending line) between its tables (`relationshipsImportsFor`, the one rule; every edit settles every diagram it touches through `settleDbmlDiagramWrites`). A diagram's members are its table `use` lines (resolved by path first, then name) plus `erd_unlinked_tables`. Reserved layer names: `tables`, `templates`, `logical-models`. DBML diagrams hold no Refs: every relationship edit on one uses `home = 'library'`. In a mixed project a DBML diagram or DBML-owned Ref may name only DBML tables (D20).

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
- **Relationships are defined once, in the model library**, stored in the many (FK) side's file (`canonicalRelationship()`; in DBML, one Ref in a relationships file, placed by `placeNewRef`). Link identity is core's `linkKey` / `sameLink` only; direction comes from `orientLink`, and when nothing decides it the dialog asks — never default from drag order. **Every canvas relationship edit is planned by the pure `planRelationshipWrite`** (the exhaustive checker in `test/unit/relationshipStateSpace.*` calls the same function); never write a second planner. Composite FKs are one entry per column pair sharing `compositeKey`, never an array. Library storage is opt-in per project by what is on disk (`usesLibraryRelationships`). Details: `docs/dev/relationships.md`.
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
- Tests alias `vscode` to the stateful mock `test/__mocks__/vscode.ts`. Fixture dbt projects live in `test/fixtures/` (`dbt-project` is the main one; `dbt-project-dbml` is the same project after Convert, regenerated with `npm run regen:dbt-dbml-fixture`; `logical-only` and `dbml-native` have no dbt).
- CI (`.github/workflows/ci.yml`) also runs a CLI smoke test, `npm pack --dry-run`, the `mcp-server/` build and the telemetry Worker checks, and fails if the VSIX exceeds 60 files.

## Architecture map

Seven esbuild targets (`esbuild.js`, each in both build and watch branches):

| Target | Source → output | Notes |
|---|---|---|
| Extension host | `src/` → `dist/extension.js` | Node, CJS |
| Webview | `webview/` → `dist/webview.js` + `.css` | browser IIFE, React; ELK worker injected via `define` (`importScripts()` is unavailable in webviews) |
| Manifest worker | `src/workers/manifestWorker.ts` → `dist/manifestWorker.js` | worker thread, plain `JSON.parse` |
| CLI | `src/cli/index.ts` → `dist/cli.js` | Node 18, **no `external`**: an `import 'vscode'` anywhere in its graph breaks the build (`test/unit/cli.noVscode.test.ts`) |
| SQL importer | `src/services/sqlImportEngine.ts` → `dist/sqlImport.js` | Node 18, `@dbml/core`'s SQL grammars (Oracle stubbed); `require`d at run time by `sqlImportLoader.ts` on the first **Import SQL DDL…**. Never import `sqlImportEngine.ts` from host code (`test/unit/sqlDdlImport.test.ts` checks the bundles' inputs) |
| SQL import worker | `src/workers/sqlImportWorker.ts` → `dist/sqlImportWorker.js` | worker thread for every Import SQL DDL… conversion (progress, Cancel, time limit), started by `workerSqlConverter` (`src/services/sqlConverter.ts`); small: it `require`s `dist/sqlImport.js` itself. No `external`. Without it the conversion runs in-process |
| Draft preview | `webview-draft/` → `dist/draft.js` + `.css` | browser IIFE, React, the renderer's `ErdCanvas` (viewer) and the ELK worker `define`; its own page and protocol (`src/types/draft.ts`, `parseDraftToHost`), nonce-only CSP with no `unsafe-inline`; writes nothing (`docs/dev/draft-first.md`) |

- Two tsconfigs: `tsconfig.json` (Node) and `tsconfig.webview.json` (DOM, includes `src/types/**`). `@types/vscode` is pinned to `1.85.0` to match `engines.vscode` — **use no newer VS Code APIs**.
- **Packages are built from source** in the extension: tsconfig `paths` and vitest aliases point `@erd-studio/core` / `@erd-studio/renderer` at `packages/*/src`; their `exports` point only at `dist/`. Core owns the pure raw-files → `DisplaySubjectArea` pipeline and the Mermaid / DBML exporters; host services delegate to it and keep only file access, caching and messaging. The renderer owns the canvas; its components post edits through `CanvasHost`, never `acquireVsCodeApi()`.
- `src/` layout: `extension.ts` (activation), `providers/` (`SemanticEditorProvider` custom editor, `GettingStartedPanel`, tree views, `payloadValidation.ts`), `services/` (business logic), `commands/`, `watchers/`, `cli/`, `harness/` (setup-skill markdown, inlined at build), `workers/`, `types/` (shared host + webview; never imports from `services/`).
- `webview/`: the editor around the renderer canvas — `components/`, `store/editorStore.ts` (Zustand; its `setDomain` override must stay last in the initialiser), `hooks/` (`useMessageBus`, `useSend()`), `host/vscodeCanvasHost.ts`, `lib/elkLayout`.
- **Not build targets:** `proxy/` (feedback analysis Worker), `telemetry/` (telemetry Worker, deployed by `deploy.yml`), `video/` (getting-started video pipeline), `mcp-server/`. Nothing in `esbuild.js`, the tsconfigs, vitest or the npm scripts may depend on `proxy/`, `telemetry/` or `video/`; `npm run build` and `npm test` must pass in a clone that never touched them.

### Two stages

| Stage | Colour | Purpose | Storage |
|---|---|---|---|
| **Logical** | Blue `#60a5fa` | Full design — columns, types, PK/FK/NK, SCD, grain, fields (purpose, decisions, the team's own) | DBML: `{layer}/tables/**.dbml` + `{layer}/relationships/*.dbml` + the diagram's `.dbml` (positions in `erd_layout`); legacy: `logical-models/**.yml` (or v6 `tables/**.yml`) + the domain file's `logical` section |
| **Physical** | Green `#22c55e` | What exists in the dbt project (source files, schema yml, `manifest.json`, `catalog.json`); relationships derived from dbt relationship tests | Derived at runtime, **never persisted** |

### Data flow

```
{layer}/diagrams/{domain}.dbml | {layer}/{domain}.json ─┐   (subjectAreaCodec: DBML or JSON)
{layer}/tables/**.dbml + {layer}/relationships/*.dbml, logical-models/**.yml ─┴→ SubjectAreaService.getSubjectArea() ─→ UnifiedSubjectArea ─→ .logical → DisplaySubjectArea
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
- Any writer of a watched file (a diagram `.json` / `.dbml`, `layers.json`, a table `.yml` / `.dbml`, a relationships `.dbml`) records `ownWrites` **after** the bytes land. A canvas drag is one splice of the diagram's `erd_layout` (`applyLayoutOnlyEdit`), never formatted.
- **DBML writes splice by parser node offsets** (`packages/core/src/dbml/`); a no-op save is byte-identical; a file that does not parse is refused, never regenerated. `src/services/dbmlWriters.ts` formats a new file; an edit changes only the lines it touches (in a file already in the canonical layout those lines are formatted, a hand-laid file gets the splice alone) — never re-pad a line an edit did not write, regroup a file's Refs, leave a run of blank lines where a cut was or put a line above its header comment (#275, spec D35). `planDbmlLibraryWrites` (`src/services/dbmlLibraryWrites.ts`) only places tables and Refs in files — `planRelationshipWrite` still decides the relationships. Every edit that creates or deletes files goes through `applyFileWrites` (`src/providers/applyFileWrites.ts`), which reconciles when `applyEdit` returns `false`.
- Model yml writes (legacy files) edit the parsed YAML document in place, so comments, key order, unknown keys, number text and aliases survive. Never regenerate a file that parses.
- Refresh paths (watchers, external edits, stage switches, the focus check, Reload Diagrams from Disk) never write. Only the initial `ready` load persists auto-computed positions, and only for a partially positioned domain. One owner-approved exception, kept that narrow: when a relationships file is **saved in this window** (`onDidSaveTextDocument` → `noteDocumentSaved`, never a watcher event or a disk-only change), each open, loaded **logical** canvas whose DBML diagram now needs to import it (the reader's drift, `relationshipsImportsFor`) gets Add the import's edit through `applyStorageEdit` (`settleImportsAfterSave`); ERD Studio's own saves (`ownWriteTracker.isPending`) are skipped. Nothing else ever writes from a change outside the canvas.
- Compare model and column names with `sameName()` / `normaliseName()` (case-insensitive). Names match `TABLE_NAME_PATTERN` / `COLUMN_NAME_PATTERN` (`src/types/naming.ts`; the renderer keeps its own copies). Refuse a case-only model rename (the write-new + delete-old edit would delete the file on macOS/Windows). Add / Rename refuse a name already in the domain or the library in any case via `TableLibraryService.findTableNameIgnoringCase`, which lists files — never `existsSync`, which is case-sensitive on Linux.
- `updateColumn` treats an omitted `scdType` / `additiveType` as "keep" and `null` as "clear".
- `meta` holds the team's own fields (and the column field `business_rule`) and is otherwise the user's free-form map: edit only through `updateMeta` patches; it is never compared, diffed or synced to dbt. `TableLibraryService.syncMeta` writes only the top-level key that changed, matching keys as the parser reads them (never via `YAMLMap.get/set`).
- **Fields** (`docs/dev/fields.md`): the catalogue, `RATIONALE_FIELD_KEYS`, the reserved names and every field spelling are decided only in core's `fields.ts`, which every reader, writer, check and renderer imports — never hand-copy a rationale key list or a reserved name. A field's value stays in its home (`rationale`, `meta` or its typed property); never add a second value map. In DBML a new value is written bare (`<key>: '<value>'`), an edit changes the spelling it read, a clear removes every spelling of that home, and nothing is renamed. Built-in text fields in YAML are camelCase `rationale:` keys only; `syncMap` deletes only the keys it manages. ERD Studio never writes `.erd-studio/fields.yml` (it opens it; the setup guide writes it on a yes), and `DisplaySubjectArea.fields` is set only when the file exists and reads as a field list (no `fieldsYamlInvalid`), in the host and core alike.
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
- The `erdStudio.feedback.*` AI settings, `erdStudio.telemetry.enabled`, `erdStudio.checkKnownFixes` and `erdStudio.claudeSync.skipPermissions` are `"scope": "machine"` **and** listed in `USER_SCOPED_SETTINGS`. Never remove either half: a checked-in `.vscode/settings.json` must not be able to redirect the analysis request (and the API key that travels with it), flip telemetry or the known-fixes check, or turn off Claude Code's permission prompts for Execute with Claude.

### Security and privacy — do not "fix" these

- **Feedback:** no image capture, picker, drop zone or paste-to-attach route (GitHub cannot accept one; `FEEDBACK_IMAGE_NOTE` is the whole Images section). `FeedbackSubjectAreaSummary` carries no domain name or layer. Keep every `redactPaths()` call site. Diagnostics are never sent to the model. Never auto-analyse text the user did not write. A pinned analysis provider never falls through to another tier. Never write `vscode.lm.` directly (use `getLanguageModelApi()`). `HOSTED_ANALYSIS_ENDPOINT` and `HOSTED_ANALYSIS_PROVIDER` change together, in one commit.
- **Telemetry:** no field may hold a name, path or message. `installId` is `crypto.randomUUID()`, never `vscode.env.machineId`. The contract with the Worker is additive (`HEARTBEAT_VERSION` stays `1`); change both sides and `telemetry.json` in one PR and deploy the Worker first. The root README never mentions telemetry.
- **Harness hooks:** the Claude PreToolUse hook and the GitHub Copilot / Codex / Gemini CLI pre-edit hooks (`src/services/assistantHooks.ts`) only ever deny; never add an allow path, and keep every one exiting 0 (Copilot fails closed).
- **dbt:** never run a project-venv dbt that `PATH` does not resolve to without `--trust-venv`; keep the skill's pre-approved dbt rules subcommand-scoped.
- **CLI:** read-only (`doctor`, `inventory`, `diff`, `export`, `changes`, `version`; `changes` reads its base from git objects and never checks out, stashes or writes). Never add a writing subcommand or an `--out` flag; assistants write `.erd-studio` files with Edit/Write so the writes stay visible.
- **No unprompted writes on activation**, apart from the legacy `erd-studio/` → `.erd-studio/` rename and refreshing `~/.erd-studio-cli` when `launcher.json` already exists. Only **Set Up My AI Helper** installs the launcher.
- Getting Started panel URLs come from fixed constants, never from the webview; its CSP stays nonce-only.
- Keep `vscode` out of worker-shared, mcp-server-shared and CLI-bundled modules (`nameUtils`, `manifestExtractor`, and every service `dist/cli.js` bundles).
- The getting-started video's audio is MP3, never AAC (VS Code's ffmpeg has no AAC decoder). The README links only the AAC copy in `docs/assets/`.

### Example projects: the customer corpus

`docs/examples/` holds eight small DBML projects, one per modelling pattern customers use (medallion, dbt staging/intermediate/marts, Kimball bus matrix, Data Vault 2.0, a database per stage, BigQuery datasets per stage, data mesh, and an Inmon enterprise warehouse that also covers the edge cases: many small source schemas, two teams sharing one schema, joins across layers, tables with no joins), explained in `docs/modelling-patterns.md`. `enterprise-warehouse/README.md` is the walkthrough a new user follows: keep its steps true to the UI when a label or flow it names changes. They are the stand-in for customers' repos: use them to judge any decision that changes how projects are read, written, drawn or laid out.

- **Before changing** the file format, readers or writers, Ref placement, layers or schemas, what the canvas or sidebar shows, `doctor`, Convert or export: open the examples (in a dev host, one window each, `code -n --user-data-dir /tmp/erdxN --extensionDevelopmentPath=<repo> docs/examples/<name>`) and say in the PR which patterns the change affects and how.
- **Three tests run over them**, and none may be weakened to make a change pass:
  - `test/unit/docExamplesProjects.test.ts`: each is a clean DBML project (`doctor` finds nothing, every file in the canonical layout, each diagram draws exactly the tables and Refs its files hold, the README tree matches the files).
  - `test/unit/dbmlDisplayParity.test.ts`: the canvas draws exactly what core draws for every example diagram.
  - `test/unit/exampleProjectsSnapshot.test.ts`: what core draws for each example (layers, tables with layer/schema/alias/role/grain/columns, each diagram's tables and relationships; no positions), against `test/golden/examples/<example>.json`. A diff there is "what changes for teams modelled this way": explain it in the PR, and regenerate (`UPDATE_GOLDEN=1`) only for an intended change, never to silence one.
- **Keep them generic.** Public patterns and invented companies only: never a customer's or an employer's real tables, names or data.
- **Add an example** when a new modelling pattern turns up (a folder with `.erd-studio/`, a README with the tree, a row in `docs/examples/README.md` and `docs/modelling-patterns.md`); every test above picks it up, and the snapshot is created with `UPDATE_GOLDEN=1`.

### Harness

- **A schema change must update the harness:** changing the on-disk schema (`packages/core/src/types/semantic.ts`, the DBML codec under `packages/core/src/dbml/` and `dbmlRichProperties.ts`, the field catalogue in `packages/core/src/fields.ts` and the `fields.yml` format, file layout, naming conventions) means updating `SCHEMA_CONTENT` (and the generators if needed) in `src/services/harnessService.ts`, **bumping `HARNESS_VERSION`**, and updating `docs/semantic-domain-json-reference.md`. Don't bump it for unrelated changes. Never silently overwrite a harness file that has no version marker. Never gitignore `.agents/`. Read `src/harness/CLAUDE.md` before editing `src/services/harnessService.ts` — it does not load on its own for files outside `src/harness/`.

### Webview

- BEM class names; colours only from the CSS custom properties in `packages/renderer/src/styles/theme.css`; React Flow node and edge type maps are module-level constants; `useSend()` rather than `useMessageBus(() => {})`.
- Host `error` messages are a dismissable toast over a live canvas; the full-screen error page is for initial-load failure only.

## Releasing

- **Every extension release is a PATCH bump unless Liam explicitly asks for a minor or major.** Leave the changelog heading as a bare `## Unreleased`; pin a version (`## Unreleased — 1.7.0`) only on an explicit request. If a change looks breaking (dropping a `schemaVersion`, removing commands or settings, raising `engines.vscode`, changing the on-disk layout), say so in your reply and still ship it as a patch unless he says otherwise.
- Put user-facing notes under `## Unreleased` in `CHANGELOG.md` in every PR (`### Added` / `### Changed` / `### Fixed` / `### Removed`). Never edit the root `version` by hand — `deploy.yml` owns it.
- Packages publish automatically on merge to `main` (patch by default). For a MINOR (a breaking change while `0.x`), set the new version in the PR: the package's `package.json`, the renderer's exact `@erd-studio/core` pin, the root dependencies, then `npm install`. Never unpublish or overwrite an npm version; fix forward.
- Edit `deploy.yml`'s `paths-ignore` and its `changes` filter together (`test/unit/deployWorkflow.test.ts`).
- **`telemetry/**` is frozen on `main` until 2.0 is on `main`** (`known-fixes.json` included): no change to it merges to `main` before the 2.0.0 release. `deploy.yml` redeploys the Worker whenever `main`'s `telemetry/` differs from the `telemetry-worker-deployed` tag, so such a merge would put the 1.7.x Worker back over the 2.0 one hand-deployed for pre-releases, and the 2.0 keys would be dropped. Details and the `d1_migrations` check: `telemetry/README.md` → Deploy.
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
- A change to how projects are read, written or drawn says which example projects (`docs/examples/`) it affects; a `test/golden/examples/` diff is explained, never regenerated just to pass
- Skip: lock-file formatting, `test/fixtures/` sample data, deploy-workflow version bump commits
