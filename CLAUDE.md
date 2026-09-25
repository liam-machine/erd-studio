# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Naming

The extension display name is **ERD Studio** (package name `erd-studio`, publisher `liamwynne`).

### Directory Structure

ERD Studio uses a **central model store** (domain schema v5). Model definitions are one YAML file per model in `.erd-studio/logical-models/` — at the top level or exactly one folder down, by convention a layer folder (`logical-models/gold/fct_order.yml`); domain JSON files at `.erd-studio/{layer}/{domain}.json` reference models **by name string** and hold relationships plus canvas layout. The custom editor activates for files matching `**/.erd-studio/*/*.json` (and the pre-0.6.44 `**/erd-studio/*/*.json` location, which activation renames in place).

The base directory is configurable via the `erdStudio.semanticDir` setting (default: `.erd-studio`).

**Model folders are organisational only** (issue #76). Domains reference models by name, and names are unique across the whole library; lookup (`LogicalModelService.findModelFile`) is top level first, then folders alphabetically, and a duplicate elsewhere is *shadowed* (ignored, flagged in the Model Library view). Dot-folders and deeper nesting are not scanned. **Folders are opt-in per project** — `LogicalModelService.groupsByFolder()` is true once any model file sits in a folder named after a configured layer (or the library is empty; callers pass the `layers.json` ids so a hand-made `Staging/` does not count). Only then does a model created from a canvas go to `logical-models/{domain layer}/`; a flat library stays flat, because a file in a folder is invisible to teammates on 1.0.x and flips everyone's Model Library to the grouped view. A rename keeps the file's folder; v4 migration applies the same rule (decided once, before writing; top level when several layers inline the model). `erdStudio.organizeModelLibrary` (`planOrganizeByLayer`) is the opt-in: it moves top-level files **and files in another configured layer's folder** into the folder of the single layer whose domains reference them, removes a layer folder it empties, never touches folders that are not in `layers.json` (reported in the dialog), and is idempotent. Migration only ever creates a folder for a configured layer. `@erd-studio/core`'s `loadDisplayDomain` cannot list directories, so it probes the top level, then every layer folder alphabetically (the extension's order, so a duplicate resolves identically) — folders not named after a layer are visible to the extension only.

```
.erd-studio/
├── layers.json
├── templates/
├── logical-models/          ← one YAML per model, shared across domains
│   ├── dim_customer.yml     ← top level (flat libraries keep working)
│   ├── bronze/              ← optional per-layer folders (one level only)
│   │   └── sap__mara.yml
│   └── gold/
│       └── fct_order.yml
├── silver/
│   ├── customer-360.json    ← domain file: logical.models = ["dim_customer", …]
│   └── orders.json
└── gold/
    └── reporting.json
```

File format detection is centralised in `detectDomainFormat()` (`packages/core/src/types/semantic.ts`) → `v5` | `v4` (inline models, loads but prompts for `erdStudio.migrateToV5`) | `hybrid` / `legacy` (rejected with an error naming the migration command; `MigrationService` repairs both). Never add a second detector. The full on-disk contract is in `docs/semantic-domain-json-reference.md`; the copy shipped to AI assistants is `SCHEMA_CONTENT` in `src/services/harnessService.ts`.

### Internal Identifiers

All internal identifiers use the `erdStudio` prefix (`erd-studio` for the activity bar container id), with the command palette category `"ERD Studio"`. The extension was originally published with a `dbtSemantic` prefix; two compatibility shims keep pre-rename users working and must **not** be removed:

- **Legacy command aliases**: every pre-rename `erdStudio.*` command is also registered in code as `dbtSemantic.*` (see `LEGACY_ALIASED_COMMANDS` at the end of `activate()` in `src/extension.ts`) so old keybindings keep working. These are code-only registrations — never contribute them in package.json. Commands added after the rename get no alias — they are listed in the exported `NO_LEGACY_ALIAS` set in `src/extension.ts`, which `registerFallbackCommands()` consults and `test/unit/extension.activate.test.ts` mirrors.
- **Legacy setting fallback**: settings are read via `getErdStudioSetting()` (`src/services/configService.ts`), which prefers explicit `erdStudio.*` values and falls back to explicit `dbtSemantic.*` values. The deprecated `dbtSemantic.projectPath` / `dbtSemantic.semanticDir` entries in package.json carry `markdownDeprecationMessage` and must stay contributed. Never read settings with `getConfiguration('erdStudio').get(...)` directly — always use the helper.

### Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `erdStudio.projectPath` | `""` | dbt project root (absolute, or relative to a workspace folder). Auto-detected when empty. Change requires a window reload (the extension prompts). |
| `erdStudio.semanticDir` | `.erd-studio` | ERD data directory relative to the project root. Change requires a window reload (prompted). |
| `erdStudio.claudeSync.skipPermissions` | `false` | Pass `--dangerously-skip-permissions` when **Execute with Claude** launches Claude Code for a sync plan. The launch command is always confirmed in a modal first. |
| `erdStudio.feedback.aiAssist` | `true` | Master switch for the Feedback dialog's single AI analysis call. On by default: tier 1 is the user's own model behind VS Code's own consent dialog. Off means no tier resolves at all. |
| `erdStudio.feedback.provider` | `vscode` | Which destination does the analysis: `vscode`, `hosted`, `endpoint`, or the legacy `auto` (the original precedence). Every value but `auto` **pins** one tier and does not fall through — an unavailable pin resolves to `none` rather than sending the text somewhere the user did not pick. The dialog's picker offers only `vscode` and `hosted`; `auto` and `endpoint` still resolve where they are set, and each shows as a row when it is the current choice. Set from the dialog's own picker via `setFeedbackProvider`. |
| `erdStudio.feedback.endpoint` | `""` | Base URL of an OpenAI-compatible chat-completions API (tier 2). Empty means "use VS Code's language model if there is one". |
| `erdStudio.feedback.model` | `""` | Model id sent to `erdStudio.feedback.endpoint`. The API key lives in `context.secrets`, never in settings. |
| `erdStudio.feedback.hostedFallback` | `true` | Allow the last-resort hosted tier (tier 3). Inert while `HOSTED_ANALYSIS_ENDPOINT` is empty; `false` removes the tier even once it is not. |
| `erdStudio.feedback.trackReports` | `true` | Poll GitHub for issues the user filed and show them in **My Reports**. Needs a silent GitHub session; the view is hidden and nobody is prompted without one. |

`erdStudio.feedback.aiAssist`, `.provider`, `.endpoint`, `.model` and `.hostedFallback` are contributed with `"scope": "machine"` and are additionally listed in `USER_SCOPED_SETTINGS` (`src/services/configService.ts`), so `getErdStudioSetting()` reads **only** their global value. A repository's checked-in `.vscode/settings.json` must never be able to point the analysis request — and the API key from secret storage that travels with it — at a host of its author's choosing. Do not remove either half: the scope keeps the value out of `inspect()`, and the list is what makes that true for this codebase's hand-rolled precedence chain.

## Build & Test Commands

```bash
npm run build          # Build extension, webview and manifest-worker bundles (esbuild)
npm run watch          # Watch mode — rebuilds on change
npm run compile        # Type-check only (both tsconfigs, no emit)
npm run test           # Run unit tests (vitest)
npm run test:watch     # Run tests in watch mode
npm run package        # Production build (minified, no sourcemaps)
npm run build:packages # Build the publishable dist/ of @erd-studio/core and @erd-studio/renderer
```

Single test file: `npx vitest run test/unit/domainService.test.ts` (package tests live in `packages/*/test/unit/` and run as part of the root `npm test`)

Tests use vitest with `vscode` module aliased to `test/__mocks__/vscode.ts` (a stateful mock: `inspect()`-backed configuration via `_setMockConfiguration`, in-memory `WorkspaceEdit`/`applyEdit`, command registry that throws on duplicate ids, `_simulateMessage` for webview messages). `test/globalSetup.ts` builds `dist/manifestWorker.js` before the run so manifest tests pass on a fresh clone. Fixture dbt projects live in `test/fixtures/` (`dbt-project` is the main one; `dbt-project-modern-tests` covers `data_tests:` / `arguments:` / versioned refs; the `-empty-manifest`, `-malformed`, `-sparse`, `-zero-byte` variants cover manifest edge cases).

CI (`.github/workflows/ci.yml`) runs on every PR: `npm audit --omit=dev --audit-level=high`, compile, build, test, package, and fails if `vsce ls --no-dependencies` lists more than 60 files. A second job type-checks, builds and smoke-tests `mcp-server/` (which imports `src/services/*` and bundles `src/workers/manifestWorker.ts` — an accidental `import 'vscode'` in a shared service fails there).

## Architecture

VS Code extension with three esbuild targets (`esbuild.js`):
- **Extension host** (Node.js, CJS) — `src/` → `dist/extension.js`
- **Webview** (Browser, IIFE with React) — `webview/` → `dist/webview.js` + `dist/webview.css`
- **Manifest worker** (Node.js worker thread) — `src/workers/manifestWorker.ts` → `dist/manifestWorker.js`

Two TypeScript configs: `tsconfig.json` (Node.js) and `tsconfig.webview.json` (DOM). The webview tsconfig includes `src/types/**/*` so types are shared. `@types/vscode` is pinned to `1.85.0` to match `engines.vscode` — do not use newer APIs.

**npm workspaces (`packages/*`).** Two packages are published to npm (0.1.0, not yet released) and are built into the extension **from source**: tsconfig `paths` (root, webview, mcp-server) and exact-match vitest aliases point `@erd-studio/core` / `@erd-studio/renderer[/editor|/store|/sizing]` at `packages/*/src`, while each package's `exports` point only at its `dist/` (`npm run build:packages`). `.vscodeignore` excludes `packages/**`; nothing there ships in the VSIX except what esbuild bundles.
- **`@erd-studio/core`** (`packages/core`) — the domain model types (`semantic`, `layer`, `display`, `discrepancy`, and the canvas edit messages in `canvasMessages.ts`) **and the pure raw-files → DisplayDomain pipeline**: `domain.ts` (`parseDomainJson`, `validateDomainDocument`, `resolveDomainLayer`, `buildUnifiedDomain`, `toLogicalStage`, `DomainFileError`, `DomainValidationError`, `NON_DOMAIN_DIRS`), `logicalModel.ts` (`parseLogicalModelText` — aliases resolved in one linear pass, optional `maxNodes` budget — and `isSafeModelName`), `layers.ts` (`validateLayersConfig`, `parseLayersText`), `displayDomain.ts` (`toDisplayDomain`, `computeMissingPositions`), `positions.ts` (the former `positionService`) and `loadDisplayDomain.ts` (one async call over a `readFile`, for hosts outside VS Code, with opt-in limits and four error classes). The host services **delegate** to it and keep only file access, caching and messaging: `DomainService.getDomain` reads the file then calls `parseDomainJson` → `validateDomainDocument` → `buildUnifiedDomain`, `LogicalModelService.readModelFile` calls `parseLogicalModelText`, `LayerService.validateConfig` calls `validateLayersConfig`, and `SemanticEditorProvider.buildDisplayDomain` calls `toDisplayDomain` with the editor payload. Core warnings carry no prefix; each host adds its own (`[DomainService] `, `[LayerService] `). `src/types/{semantic,layer,display,discrepancy}.ts` and `src/services/positionService.ts` are named re-export shims. Core may not import Node built-ins, `vscode`, React or React Flow. **Parity:** `test/unit/displayDomainGolden.test.ts` pins what the host posts (goldens in `packages/core/test/fixtures/golden`, regenerate with `UPDATE_GOLDEN=1` only for an intended change) and `packages/core/test/unit/loadDisplayDomain.golden.test.ts` holds core's one-call pipeline to the same files.
- **`@erd-studio/renderer`** (`packages/renderer`) — the diagram canvas: `ModelNode`, `FkEdge`, `AnnotationNode`/`AnnotationEdge`, `DetailPanel` (with its editors), `Legend`, the `common/` key-badge and column-row components, the canvas hooks (`useColumnExpansion`, `useColumnReorder`, `useFocusWithinRow`, `useLongPressDrag`), the pure `lib/` helpers (`graphTransformer`, `nodeOverlays`, `edgeDistribution`, `nodeSizing`, `stageColors`, …), the canvas store slice and `styles/theme.css`. Components get their store from `CanvasStoreProvider` (React context) and post edits through the `CanvasHost` from `CanvasEnvironmentProvider` — never `acquireVsCodeApi()` directly. Entry points: `.` (viewer API and types), `/editor` (everything the webview uses), `/store` (store slice + context, no React Flow runtime) and `/sizing` (node size estimation for the ELK runner). `test/unit/packagesBoundary.test.ts` guards these rules.
  - **Viewer mode.** `ErdCanvas` (`src/ErdCanvas.tsx`, derived from `EditorCanvas` in `webview/App.tsx`) is the read-only viewer for pages outside VS Code: its own store per instance, `readOnly` forced, optional local-only dragging (`lib/dragHandleSides.ts` re-picks the moved nodes' edge sides with `pickHandleSides`; `resetLayout()` restores them). It sets `CanvasEnvironmentProvider`'s `viewer` flag, which components read with `useIsViewer()` to drop the affordances a domain's `readOnly` still shows (clickable relationship rows, the key-type menu arrow — kept but hidden so rows align — empty rationale fields and "+ Add", node context menu, column long-press, annotation double-click). Every viewer gate is `viewer ? … : <upstream expression>`, so the extension (no `viewer`) renders exactly as before; `test/unit/extensionMode.test.tsx` and `ErdCanvas.viewer.test.tsx` in the package pin both sides.
  - The README lists every `--vscode-*` variable the package's CSS and TSX read; a page embedding `ErdCanvas` must define them. Update that list when a component starts reading a new one.

`proxy/` is a **fourth thing that is not part of the extension**: the Cloudflare Worker behind the feedback analysis fallback tier (`HOSTED_ANALYSIS_ENDPOINT`). It is deployed by hand from [`proxy/README.md`](proxy/README.md) — which is also where the operator's obligations are spelled out, since running it means processing other people's bug descriptions through a publicly reachable URL — it is listed in `.vscodeignore` so it never ships in the VSIX (CI fails above 60 files), and nothing in `esbuild.js`, the tsconfigs or the npm scripts may come to depend on it — `npm run build` and `npm test` must stay green in a clone that has never touched it. It has no dependencies and no build step: `proxy/src/index.js` is plain JavaScript that deploys as written, checked in place with `node --check` and the local `proxy/tsconfig.json` (`checkJs`), which the root build does not reference.

### Two-Stage Architecture

The extension uses two design stages, each with a distinct purpose:

| Stage | Color | Purpose | Storage |
|-------|-------|---------|---------|
| **Logical** | Blue (`#60a5fa`) | Detailed data model — full columns, data types, PK/FK/NK, SCD types, grain, rationale | `logical-models/[{folder}/]*.yml` (model bodies) + `logical` section of the domain file (model names, relationships) |
| **Physical** | Green (`#22c55e`) | What exists in the dbt **project** — a model exists when a source file under `model-paths`/`seed-paths`/`snapshot-paths` (and not disabled by dbt), a schema `.yml`, a manifest node **or** a `catalog.json` relation carries it; columns are the union of the catalog's observed list and the declared (yml, else manifest) one; types fall through catalog → yml `data_type:` → manifest; relationships & cardinality derived from the union of yml and manifest test declarations; every model carries `provenance` naming its sources; read-only | Derived at runtime, no file on disk |

Stage colors are defined in `packages/renderer/src/lib/stageColors.ts`.

### Data Flow

```
{layer}/{domain}.json ─┐
logical-models/**.yml ─┴→ DomainService.getDomain() ─→ UnifiedDomain ─→ .logical → DisplayDomain
                                                                                          │
schema .yml + source files ─→ YmlParserService ─┐                                         │
manifest.json              ─→ ManifestService  ─┼→ buildPhysicalDomain() ─→ DisplayDomain │
catalog.json               ─→ CatalogService   ─┘                                         │
                                                                                          │
                                                    [message] ─→ graphTransformer ─→ React Flow
```

1. **ManifestService** parses `{target-path}/manifest.json` in a worker thread (`dist/manifestWorker.js`, plain `JSON.parse` — there is no streaming parser or `stream-json` dependency) so 40MB+ files do not block the extension host. `src/workers/manifestExtractor.ts` (pure, shared with tests) extracts model nodes, relationship test nodes (`relationships`, `relationships_where`, custom), `unique` tests and `unique_combination_of_columns` tests, plus the names in the manifest's `disabled` section (the veto on filesystem existence — see step 4), resolving dbt versioned models (`model.proj.name.vN`, `ref('m', v=N)`) to the latest version. A missing manifest is definitive (`ManifestMissingError`, `isMissing` flag); a malformed one is treated as transient (dbt mid-write) and the last known good result is served with `isStale`. Runaway parses are abandoned after `DEFAULT_PARSE_TIMEOUT_MS`.
2. **DbtProjectConfig** (`src/services/dbtProjectConfig.ts`) reads `target-path` / `model-paths` / `seed-paths` / `snapshot-paths` from `dbt_project.yml` once at activation; ManifestService, CatalogService, YmlParserService, FileWatcherService and the staleness check all use those paths rather than hard-coded `target/`, `models/`, `seeds/` and `snapshots/`. `modelPathsGlob()` is the yml/staleness glob, `sourcePathsGlob()` the wider one the source watcher uses, and `resolveCatalogPath()` locates `{target-path}/catalog.json`.
3. **DomainService** reads a domain JSON → `UnifiedDomain` (the parsing and repair rules are `@erd-studio/core`'s `domain.ts`), resolving each model name through **LogicalModelService** (`logical-models/{name}.yml` or `logical-models/{folder}/{name}.yml`, found by `findModelFile()`; parsed with `yaml` `parseDocument` and written back by editing that same document in place, so comments, key order and unknown keys survive every UI write — including a canvas rename, which carries the old file's document across via `serializeModel(model, fromName)`. Two exceptions: a file that fails to parse is regenerated from scratch, and folded `>` block scalars are re-emitted on one line, value unchanged. A missing file renders as a placeholder with a warning), then extracts a stage section via `getDomainStage()` → `DisplayDomain`. Malformed `viewConfig.positions` entries and relationships missing endpoints are dropped with a console warning.
4. For physical stage: `DomainService.buildPhysicalDomain(unified, ymlData, manifest, catalog)` resolves each logical model against the dbt **project**, not against the manifest alone. **Existence** is `sourceFile ∪ yml ∪ manifest ∪ catalog`, where the source-file branch (a `.sql`/`.py`/`.csv` stem under a model/seed/snapshot path, indexed by `YmlData.sourceFiles`) is vetoed by `ManifestData.disabledModels` — `ref()` to a disabled model fails, so a bare file must not read as "exists". A model in none of those is **still emitted**, with `existsInProject: false`, a `missingReason` (`'absent'` | `'disabled'`), no columns and no `provenance`, and is kept out of `physicalModelNames` so it pulls in no edges — it ghosts on the canvas instead of vanishing. **Columns** come from two kinds of source: the *declared* list is the yml when present, else the manifest per model (one source — the manifest's columns are a compiled copy of the same yml patch, so disagreement there is only staleness), and the *observed* list is `catalog.json`. With a catalog node the rendered list is their union in catalog order with declared-only columns appended; with none it is the declared list, exactly as before. The declared spelling always wins for display (Snowflake's UPPERCASE keys never relabel the canvas). **Types** fall through catalog → declared `data_type:` → manifest → `''`; **descriptions** run the other way (yml → manifest → catalog `comment`, because `persist_docs` writes the dbt description *into* that comment); **`schema`** is manifest → catalog `metadata.schema` → `''` (manifest first: the two agree on the value and differ only in case, and with neither the node badge falls back to the layer abbreviation). Catalog nodes resolve by manifest `unique_id` first, then by normalised name. **`provenance`** (`{ columns: PhysicalColumnSource[]; types: PhysicalColumnSource }`) is computed in the same pass — `columns` lists every contributing source most-authoritative-first, `types` names the highest-authority source that supplied any type. It is runtime-only: nothing about it is persisted, and `buildDisplayDomain` (the logical literal) never sets it. **Relationships are derived from the union of yml and manifest relationship tests** (deduped; never copied from logical; `catalog.json` carries no constraint information and contributes no edges). Cardinality is inferred from `unique`/`unique_combination_of_columns` tests merged from both sources (no unique test = "many" side). Model and column names are matched case-insensitively (`normaliseName()` in `src/services/nameUtils.ts`). Relationships are scoped to models within the domain to prevent conformed dimensions from pulling in external edges. See `derivePhysicalRelationships()` in `domainService.ts`. YmlParserService parses schema yml under the configured model paths only, but walks model, seed and snapshot paths for source files (skipping `dbt_packages`, `dbt_modules`, venvs), reads both `tests:` and `data_tests:` keys, `unique` as a scalar or map form, and dbt 1.10 `arguments:` nesting; both parsers accept versioned `ref('model', v=2)`. **CatalogService** (`src/services/catalogService.ts`) reads `{target-path}/catalog.json` — written by `dbt docs generate` — for real warehouse column lists and types, caching the "no catalog" answer too, so it must be invalidated on `onCatalogChanged` and in `refreshManifest`.
5. **DiscrepancyService** compares two `DisplayDomain` objects (case-insensitive keys, raw names preserved on the report) to produce a `DiscrepancyReport`
6. Extension sends `domainLoaded` / `stageData` message to webview
7. **graphTransformer** converts `DisplayDomain` → React Flow nodes + edges (with optional discrepancy overlays); `nodeOverlays.applyNodeOverlays` layers dimming/expansion on top with identity preservation so memoised nodes skip re-rendering
8. **elkLayout** runs ELK auto-layout in a Web Worker (injected at build time as `__ELK_WORKER_CODE__`; 30 s timeout, failures surface as a toast)

### Extension Host (`src/`)

| Directory | Purpose |
|-----------|---------|
| `extension.ts` | Activation: dbt project detection, command registration, harness update prompt, watchers wiring, legacy aliases |
| `providers/` | `SemanticEditorProvider` (custom editor), `DomainTreeProvider` / `ModelLibraryTreeProvider` / `MyReportsTreeProvider` (sidebar trees), decoration providers, `payloadValidation.ts` (runtime checks for webview payloads) |
| `services/` | Business logic — `manifestService`, `catalogService`, `ymlParserService`, `domainService`, `logicalModelService` (yml model store), `migrationService` (v4→v5, legacy dir rename), `discrepancyService`, `layerService`, `templateService`, `selectorsService`, `harnessService`, `feedbackService` (Send Feedback), `feedbackAnalysisService` (opt-in AI analysis), `reportTrackingService` (My Reports), `dbtProjectConfig`, `ownWriteTracker`, `configService`, `nameUtils`, `stalenessService`, `recoveryService`, `positionService` (re-export shim of core `positions.ts`), `legacyTagCleanupService` |
| `watchers/` | `FileWatcherService` — debounced (300 ms) watchers for the dbt artifacts (`manifest.json` + `catalog.json`, separate events), dbt source files, domain files, `layers.json`, `logical-models/`, `dbt_project.yml` |
| `workers/` | `manifestWorker.ts` (worker entry) and `manifestExtractor.ts` (pure extraction, also used by `mcp-server/`) |
| `types/` | Shared type definitions (imported by both host and webview), incl. `naming.ts` (`MODEL_NAME_PATTERN`, `COLUMN_NAME_PATTERN`) |

### Webview (`webview/`)

The canvas itself lives in `@erd-studio/renderer` (above); `webview/` is the editor built around it. `App.tsx` wraps everything in `CanvasStoreProvider` (the singleton store below) and `CanvasEnvironmentProvider` (`host/vscodeCanvasHost.ts`, which forwards canvas edits to `acquireVsCodeApi().postMessage`), and gets its nodes, edges and click handlers from the renderer's `useCanvasGraph`.

| Directory | Purpose |
|-----------|---------|
| `components/` | React components — `Graph/DragLine`, `DiscrepancyPanel/`, `WelcomeModal/`, `Toolbar/` (StageTabs; the top-right corner actions collapse to an overflow `⋯` menu only when `measureCorner()` finds they would overlap the top-centre toolbar — measured from the live layout, because the toolbar's width depends on the domain name, the search box and the stage-specific controls, and a CSS breakpoint could only approximate it; where nothing can be measured the labels stay), `FeedbackDialog/` (dialog incl. the header `KindSwitch`, `AnalysisPanel` incl. the destination picker, `DuplicateTakeover`, `DiagnosticsChips`, `FeedbackFooter`), `Toast/`, dialogs |
| `store/` | Zustand singleton (`editorStore.ts`) — the renderer's `createCanvasSlice(set)` (selection, nodes/edges, expansion, context menus, column selection) plus the editor's own state: dialogs, active stage, discrepancy, toast/error, feedback dialog (diagnostics, capabilities, analysis). Its `setDomain` overrides the slice's with the full reset (error, physical-source notice, discrepancy/sync, canvas mode) and must stay last in the initialiser |
| `hooks/` | `useMessageBus` (extension comms; `useSend()` for a stable sender), `useVsCodeApi` (+ `getVsCodeApi()`), `useCanvasShortcuts` (global keydown — reads store via `getState()`, registered once), position/state persistence (flushed on `visibilitychange`/`pagehide`) |
| `host/` | `vscodeCanvasHost.ts` — the `CanvasHost` the renderer's components post edits to |
| `lib/` | `elkLayout` (the ELK runner; node sizing comes from `@erd-studio/renderer/sizing` and is re-exported), `keyboardShortcuts`, `stageRequest`, `stageUtils`, `validation` |
| `styles/` | `host.css` — the webview's `html, body, #root` sizing, loaded after the renderer's `theme.css` (CSS custom properties mapping VS Code theme vars) |

### Message Protocol (`src/types/messages.ts`)

Extension <-> Webview communication uses discriminated unions on `type` field:
- **Extension -> Webview**: `domainLoaded`, `stageData`, `discrepancyReport`, `manifestStaleness`, `syncPlanGenerated`, `openFeedback`, `feedbackContext`, `feedbackAnalysis`, `feedbackSubmitted`, `error`
- **Webview -> Extension**:
  - lifecycle/navigation: `ready`, `dismissWelcome`, `viewFile`, `requestReload`, `switchStage`, `refreshManifest`, `undo`, `redo`
  - schema mutations: `addModel`, `addExistingModel`, `renameModel`, `removeModel`, `removeModels`, `addColumn`, `removeColumn`, `updateColumn`, `reorderColumns`, `toggleColumnKey`, `updateModelDescription`, `updateModelGrain`, `updateModelRole`, `updateModelRationale`, `addRelationship`, `updateRelationship`, `editRelationship`, `removeRelationship`, `removeRelationships`
  - canvas metadata: `updatePositions`, `addAnnotation`, `updateAnnotation`, `removeAnnotation`, `removeAnnotations`
  - sync/discrepancy: `toggleDiscrepancy`, `generateSyncPlan`, `runDbtCompile`, `launchClaudeSync`
  - feedback: `requestFeedbackContext`, `analyzeFeedback`, `setFeedbackProvider`, `submitFeedback`, `copyFeedbackReport`, `openFeedbackLink`

Every type in the unions has a live sender and handler — do not add a message type without wiring both ends (unknown types are logged by the `default:` branch, never silently dropped). Multi-select operations are batched: `removeModels`, `removeAnnotations`, `removeRelationships` and `updatePositions` (which carries `annotations?: [{id,x,y}]` for notes moved in the same drag) each produce **one** `WorkspaceEdit`, one save, one `domainLoaded` — i.e. one undo step. `switchStage` carries a `requestId` that the host echoes on `stageData` so the webview can drop stale replies (`webview/lib/stageRequest.ts`).

**Physical stage guard.** While a panel is viewing the physical stage the host rejects every message not in this allowlist with a `"Physical stage is read-only"` `error`:

```
ready, updatePositions, switchStage, toggleDiscrepancy, refreshManifest, dismissWelcome,
viewFile, generateSyncPlan, runDbtCompile, launchClaudeSync,
addAnnotation, updateAnnotation, removeAnnotation, removeAnnotations, requestReload,
requestFeedbackContext, analyzeFeedback, setFeedbackProvider, submitFeedback,
copyFeedbackReport, openFeedbackLink
```

Positions and annotations are allowed because they live in the shared `viewConfig` (physical inherits logical positions); `generateSyncPlan` is the physical-stage "Compare to Logical" flow; the six feedback types write no domain data at all (`setFeedbackProvider` writes a user setting, never a file). `undo`/`redo` are deliberately **not** allowed (the toolbar hides them there) — they would rewind the logical document under a derived view.

**Edit pipeline.** All domain-file writes go through `applyDomainEdit()` in `SemanticEditorProvider` — the only place a domain `WorkspaceEdit` is built: parse → mutate → replace whole document → `applyEdit` → `document.save()` → refresh, with `pendingUpdates` held so the change listener never double-saves. Edits are saved immediately; the custom editor never sits dirty. A mutator throws `EditAborted` to bail out after reporting its own error; pass `errorLabel` for the applyEdit-rejected case and `onSuccess` for follow-up work such as `selectorsService.scheduleRegenerate()`. `applyModelEdit()` routes `logical-models/*.yml` changes through the **same** `WorkspaceEdit` (`modelFiles: { save: [{ model, fromName? }], delete }`) so a model edit and its domain change are atomic and one undo step — never `fs.writeFileSync` a model file from a handler (`addExistingModel` seeds a new library file the same way, so a rejected edit leaves no orphan yml). `fromName` names the file whose existing YAML document supplies comments / key order / unknown keys: a rename passes the OLD name so hand-written content is carried to the new file instead of being regenerated. Every file the pipeline writes is recorded in `ownWrites` **after** the bytes land (the tracker stats the file), so the watchers skip our own saves; the refreshes they used to drive are issued directly instead — `sendDomainData` for the editing panel, `refreshDomainsReferencingModel(name, exceptPanelKey)` for other open panels, and the `onDidWriteDomain` event for the tree / model library views. An undo/redo flushes only the yml documents this provider itself wrote for that domain (`editedModelPaths`) — a model file the user is hand-editing in another tab is never force-saved. Payloads are validated at the message boundary by `src/providers/payloadValidation.ts` (model names via the shared `MODEL_NAME_PATTERN` in `src/types/naming.ts`, column lists incl. duplicates, `keyType`, `cardinality`, `modelRole`, finite positions); `LogicalModelService.modelPath` refuses names that escape `logical-models/`. The message listener is wrapped in `withMessageErrorBoundary()` so a throwing handler posts an `error` instead of becoming an unhandled rejection. Refresh paths (watchers, external edits, stage switches) never write — only the initial `ready` load persists auto-computed positions.

### Activation (`src/extension.ts`)

- **Project detection** — `resolveDbtProjectRoot()` honours `erdStudio.projectPath`, then workspace folder roots, then a depth-3 search for `dbt_project.yml` (skipping `node_modules`, `dbt_packages`, `.git`, `target`, venvs). With no project found, `registerFallbackCommands()` registers every contributed command (plus aliases) with a "no dbt project" warning and a stub custom editor, so nothing reports "command not found".
- **`erdStudio.reportBug`** (titled **Send Feedback**) is registered before any early return so it always works. `ReportTrackingService` and `MyReportsTreeProvider` are constructed immediately after `editorProviderForFeedback = editorProvider` — before `refreshContextKeys()` is defined and synchronously called — and the provider gets the tracker via `setReportTracking()` rather than a sixth constructor argument.
- **Update recovery** — if the extension version changed since last activation and a canvas is open, the host offers a save-all + window reload (`recoveryService`); the webview also detects orphaning and sends `requestReload`. The custom editor is registered with `retainContextWhenHidden`.
- **No unprompted writes** — activation may rename a legacy `erd-studio/` dir to `.erd-studio/` (with a notice) but otherwise writes nothing: `SelectorsService.regenerate()` returns `noop` when there is nothing to write, harness updates and v4→v5 migration always prompt.
- **Context keys** `erdStudio.hasSemanticDir` / `erdStudio.hasLogicalModelsDir` are refreshed by `refreshContextKeys()` after every relevant watcher event and command. `erdStudio.hasTrackedReports` (which gates the **My Reports** view) is deliberately **not** one of them — `ReportTrackingService` sets it itself, so activation never has to reference the service from `refreshContextKeys`.
- **Settings changes** to `semanticDir` / `projectPath` (either prefix) prompt for a window reload.

### Watchers (`src/watchers/FileWatcherService.ts`)

Own writes are recorded in `ownWrites` (`src/services/ownWriteTracker.ts`, path + mtime/size, 5 s TTL) by `SemanticEditorProvider` (the editor write path — domain file, model yml saves, creates and deletes), `LogicalModelService`, `LayerService` and the `deleteDomain` command, and consumed in the callbacks that watch files the extension itself writes (domain `.json` changes and deletes, `layers.json`, `logical-models/*.yml`) so an extension save never triggers a second identical refresh. The manifest, catalog and `dbt_project.yml` callbacks have nothing to consume — the extension never writes those. One watcher covers both dbt artifacts (`{target-path}/{manifest.json,catalog.json}`) on separate debounce keys, firing `onManifestChanged` or `onCatalogChanged`; one covers dbt source files (`{model,seed,snapshot}-paths/**/*.{yml,yaml,sql,py,csv}`) and fires `onDbtYmlChanged` on create and delete of any of them but on change only for yml — a `.sql` body edit changes no shape the physical stage reads. `renameDomain` (`extension.ts`) is the one gap: its create+delete `WorkspaceEdit` records neither path, so the old file's delete is seen as external. `classifySemanticPath()` ensures only `{layer}/{domain}.json` fires `onSemanticFileDeleted` (coalesced to one `{ uris }` event per burst); `layers.json` has its own `onLayerConfigChanged`. `LayerService.loadConfig()` is mtime-validated and refuses to overwrite an unreadable/invalid `layers.json` (`getLoadError()`).

## Send Feedback

`erdStudio.reportBug` — the command id is kept for existing keybindings; its title is **Send Feedback** — opens a **prefilled GitHub issue form** (`.github/ISSUE_TEMPLATE/bug_report.yml` or `feature_request.yml`, repo `liam-machine/erd-studio`) via `vscode.env.openExternal`. Nothing is ever filed from the extension: the user reviews the form and presses Submit on github.com as themselves, so no write token is needed. It is reachable from the palette, the sidebar title bar, the canvas toolbar and the canvas error screen.

- **With a canvas** the host posts `openFeedback` (optional `{kind, title, description}` prefill) and the webview's `FeedbackDialog` takes over. It posts six messages, all on the physical-stage allowlist: `requestFeedbackContext` (on open) → `feedbackContext`, whose `capabilities.aiNeedsPriming` tells the dialog to render the first-run button instead of auto-running; `analyzeFeedback` (debounced, or `trigger: 'user'` from that button) → `feedbackAnalysis`; `submitFeedback` → `feedbackSubmitted`; plus `setFeedbackProvider` (the destination picker) → another `feedbackContext`, `copyFeedbackReport` and `openFeedbackLink`. **Without a canvas**, a QuickPick (`Report a bug` / `Request a feature`) then two input boxes gather the kind, title and description.
- **Kind.** `FeedbackKind = 'bug' | 'feature'` drives the issue template, the field ids (`steps` vs `rationale`) and every label — all of the frozen copy is `FEEDBACK_COPY` in `src/types/feedback.ts`, which both ends import rather than re-declaring. That file is compiled by both tsconfigs **and** the mcp-server job, so it must stay free of `vscode` and of DOM types; the pure helpers the webview needs (`readinessScore`, `footerRoute`, `compareVersions`, `duplicateModeFor`, `applyRegressionPrefix` / `stripRegressionPrefix`) live there for exactly that reason. **The kind is a live negotiation, not a default.** The dialog opens on `bug`, every analysis reply re-applies its verdict (`if (!kindLocked) setKind(analysis.kind)`), and the header's `KindSwitch` — a two-segment `Bug | Feature` control — is how the user overrules it: picking a segment sets `kindLocked`, after which no analysis may move it, and the trailing `your choice · auto` button hands it back (clearing the lock re-runs the effect, so the current verdict is re-applied at once rather than at the next request). A `prefill.kind` from the palette locks it from the start. **`analyzeFeedback` carries `kindChosenByUser`**, and the host states the kind to the model *only* when it is true: `buildAnalysisPrompt()` used to open "The user is filing this as a bug, but decide for yourself" on every fresh dialog — presenting the dialog's opening default as something the user had said, and then asking the model to disagree with it — which is why "I want a new ability to have a new feature" came back classified as a bug. Unchosen, the prompt says "The user has not said which kind this is" and the context heading goes neutral too (`--- what else they said ---`, not `--- steps they gave ---`). The system prompt now also *defines* the two kinds and calls out the phrasings that were being misread. The switch is a **permanent header fixture**: on a host where no tier resolves (no language model, no endpoint, no hosted service) it is the **only** route to the feature-request template, so it must never be moved into `AnalysisPanel` — that panel shows a read-only verdict chip and points at the header instead.
- **The verdict shows both kinds.** `kindSplit()` (`src/types/feedback.ts`) turns the model's single `confidence` into a share for each kind — the choice is binary, so one number describes both sides and the model is deliberately **not** asked for two, which could disagree about what they sum to. A confidence below 0.5 is incoherent (the model picked the side it thinks less likely) and is floored at 50, because "Bug 30% / Feature 70%" under a verdict chip reading *Bug* is worse than admitting a coin toss. Below `KIND_CONFIDENCE_CLOSE` (0.65) the panel calls it a close call and says to pick one in the header — a single chip made a 51/49 guess look identical to a near-certainty, so the one case where the user most needs the switch was the case that gave them no reason to reach for it. The split is always the **model's** answer, not the dialog's current kind; when the user has overruled it the hint says so rather than leaving the two quietly disagreeing.
- **Images — there is no route, and that is the feature.** GitHub has no API for attaching an image to a prefilled issue form, so anything the extension captured could only be handed back to the user to paste on github.com themselves — the job they already have, done twice, plus a clipboard that is allowed to refuse and a file left on disk to explain. The dialog therefore has **no checkbox, no capture, no picker, no drop zone and no paste-to-attach**: the Images section is one sentence, `FEEDBACK_IMAGE_NOTE` in `src/types/feedback.ts`, saying to paste or drag into the Screenshot box once the form opens. Do not add any of those routes back. Gone with them: `webview/lib/screenshot.ts`, `webview/lib/feedbackAttachments.ts`, the `html-to-image` dependency, `FeedbackAttachment` and its mime/size constants, `validateFeedbackAttachment(s)`, `saveAttachments()` / `saveScreenshot()` and the **Reveal Folder** notification, and the `attachments` / `screenshotError` / `attachmentNames` fields on the messages. `composeFeedbackFields()` deliberately leaves the bug form's `screenshot` field **empty** — prefilled text there would be an instruction the user has to clear before they can drop their own image in.
- **Diagnostics** are collected by `collectDiagnostics()` and shipped to the dialog as `buildDiagnosticsView()` — chips plus the verbatim `formatDiagnostics()` text — so the webview never reconstructs them. **`FeedbackDomainSummary` carries no domain name or layer**: `gold/commercial` is the user's own business vocabulary, names a project the maintainer cannot open, and bought nothing a report needs, so the fields were removed from the type rather than filtered downstream — the canvas contributes `stage`, `schemaVersion` and the two counts, and there is no path from a canvas to a domain name in a filed issue. Do not add them back. `composeFeedbackFields()` builds the issue-form fields and `buildIssueUrl()` truncates the verbose ones to stay under `MAX_ISSUE_URL_LENGTH`; `composeMarkdownReport()` backs the **Copy report** button, which needs no network, no GitHub and no model.
- **AI assist (`src/services/feedbackAnalysisService.ts`)** — one optional call, behind `erdStudio.feedback.aiAssist` (**on** by default), returning kind + confidence, a suggested title, extracted context, gap prose and ranked duplicates. `resolveAnalysisTier()` picks between four tiers. With `feedback.provider` set to the legacy `auto` the order is the one that lets the user's own choices win: **(1)** VS Code's language model, feature-detected at runtime through the `getLanguageModelApi()` shim (`engines.vscode` stays `^1.85.0` and `@types/vscode` stays 1.85.0 — never write `vscode.lm.` directly), selected with **no** selector so any vendor is accepted; **(2)** an OpenAI-compatible endpoint (`feedback.endpoint` + `feedback.model`, key in `context.secrets` via `erdStudio.setFeedbackApiKey`); **(3)** the author's hosted proxy at the build-time constant `HOSTED_ANALYSIS_ENDPOINT` (see `proxy/`), gated by `feedback.hostedFallback`; **(4)** none, in which case the dialog is exactly the pre-AI dialog. **Every other value of `feedback.provider` pins one tier and does not fall through** — an unavailable pin resolves to `none`, because falling back would send the text to the destination the user pinned away from. **The default is `vscode`**, so a machine with no language model resolves to `none` and is offered the ERD Studio service rather than being routed there unasked. That is what makes "I have Copilot but would rather not spend it triaging my own bug report" expressible: the dialog's `AnalysisPanel` head is a `<select>` fed by `listAnalysisOptions()` (the two rows in `OFFERED_PROVIDER_CHOICES` — `vscode` and `hosted` — plus the current choice when it is `auto` or `endpoint`, so a user pinned to one can still see and leave it; unavailable rows are disabled with the reason in `note`), and choosing one posts `setFeedbackProvider` → `setAnalysisProviderChoice()`, which writes the setting to the **global** target (it is user-scoped, so a workspace value would be read by nothing) and replies with a fresh `feedbackContext`. That write is guarded by `providerSettingRegistered()`, which asks whether this window has the key at all by inspecting its `defaultValue` — an in-place extension update restarts the extension host onto the new `dist/extension.js` (which is why the picker is on screen) while the window still holds the previous version's manifest, and VS Code then rejects the write as "not a registered configuration". `describeProviderWriteFailure()` turns exactly that case into `PROVIDER_SETTING_UNREGISTERED`, which asks for a window reload; every other failure keeps the generic prefix, because dressing an unexpected error up as one with a known fix sends the user to reload for nothing. The panel renders whenever *any* row is available, not only when a tier resolves — a pin that stops working must leave the picker on screen, or the way back disappears with it. `feedback.hostedFallback: false` still vetoes an explicit `hosted` pin: "never send my text there" has to mean that even when the picker is the thing asking. Tiers 2 and 3 are the **same** request through `postChatCompletion()` — the hosted one simply carries no `Authorization` header, because the proxy holds the key; do not write a second client. **Diagnostics are never sent to the model** — `buildAnalysisPrompt()` takes no `Diagnostics` parameter by construction, and a unit test asserts the prompt contains none of it. **Consent is split by who chose the destination.** Tier 1 shows **no modal of ours**: VS Code's language model access dialog is the real gate and it already names the extension. What tier 1 does instead is honour the "not out of the blue" guidance — an unprimed machine refuses a debounced request and only runs one carrying `userInitiated` (the panel's **Analyse this for me** button), then sets `FEEDBACK_LM_PRIMED_KEY` in `globalState` on the **first successful** request so the debounce runs unattended for ever after. A failure must not set it, or a dismissed dialog would kill the feature silently. Tiers 2 and 3 always ask, once **per destination** — the accepted host is what is stored under `FEEDBACK_AI_CONSENT_KEY`, not a boolean, so re-pointing `feedback.endpoint` asks again instead of inheriting a yes about somewhere else; the hosted prompt additionally names **both** the author's relay and `HOSTED_ANALYSIS_PROVIDER` — the third party the relay forwards to under the author's key — and says how to turn it off, because the user did not pick that destination; its stored consent is keyed `"<host>|<provider>"` so a change of processor re-asks. `safeBaseUrl()` (behind both `endpointBaseUrl()` and the hosted target) accepts only `https:`, plus `http:` on loopback for a local model server or a `wrangler dev`; anything else resolves to `''` and the tier degrades to `none`. **`HOSTED_ANALYSIS_ENDPOINT` and `HOSTED_ANALYSIS_PROVIDER` are now filled in** (`https://erd-studio.liam-is-an.ai`, forwarding to `DeepSeek`), so the hosted tier is **live in published builds** — a `hosted` pin, or an `auto` resolution on a machine with no language model and no endpoint, reaches a real service. `resolveAnalysisTier()` requires **both** constants, so clearing either one back to `''` takes the tier down again in a single line and an endpoint shipped without a named recipient resolves to `none` rather than sending text under a disclosure that omits who receives it — they move together, in one commit. `setHostedAnalysisTargetForTests()` is the only other way to reach the tier. Every failure degrades to `{ analysis: null }`; a model outage must never block a report. Duplicate candidates are **hydrated** from the fetched issue list — `parseAnalysisResponse()` takes only `{ number, match, why }` from the model, so a hallucinated `state_reason` can never tell someone to update for a bug that is still open.
- **Duplicate takeover.** `fixed` mode is three-valued (`FixState` in `DuplicateTakeover.tsx`): `outdated`, `current`, or — the ordinary case, because GitHub only records a fix version when the issue carries a milestone or a `shipped-in:` label — `unknown`. Only `current` may claim a regression: it is the one state where the user demonstrably has the fix, and it alone sets `regressionOf` and the `Regression: ` title prefix. `unknown` asserts nothing and offers **File it anyway**. A "file anyway" / "regression" choice is bound to the duplicate it was made against (`choiceFor`), so a later analysis cannot carry it onto an unrelated issue.
- **No local path leaves the machine.** `redactPaths()` (`src/types/feedback.ts`, shared so the webview can use it) rewrites every absolute path — POSIX, `~/`, Windows drive, UNC, `file://` and webview `vscode-resource` URLs — to the *shape* of what it points at: `{project}/.erd-studio/{layer}/{domain}.json`, `…/logical-models/{model}.yml`, `…/templates/{template}.json`, `{extension}/dist/…` for our own install folder, `{path}/manifest.json` for the dbt/ERD fixed names in `KEPT_FILE_NAMES`, else `{path}/{file}.ext`. It recognises paths by shape, not by per-message regexes, so it holds for error messages written later; it is idempotent and uses `{…}` because GitHub strips unknown `<tags>`. It runs in `collectDiagnostics()` (both error lists — so the dialog's verbatim view is what gets sent; `hostErrorLog` itself stays raw), `composeIssueFields()` / `resolveFeedbackTitle()` / `composeMarkdownReport()` (what the user typed, since pasting the toast is the ordinary way to describe an error), `buildAnalysisPrompt()`, and the error screen's prefill in `webview/App.tsx`. `test/unit/feedbackRedaction.test.ts` pins both the shapes and that wiring. Do not remove any of these call sites.
- **Nothing auto-sends text the user did not write.** The canvas error screen opens the dialog with the host's raw exception as the description; after `redactPaths()` that string still carries dbt model names. `FeedbackDialog` keeps the opening description in `prefilledDescriptionRef` and suppresses the debounce while the field still equals it, offering the same **Analyse this for me** button instead; one keystroke makes the text the user's and the debounce resumes. Do not "fix" this by also scrubbing model names from the error string — the host builds those messages in several validators and any per-message regex would rot (paths are different: they have a shape, which is what `redactPaths()` keys on). `runAnalysis` additionally refuses a **debounced** repeat of the request already in flight (same text *and* same request id), which is what stops the primer's hand-over from firing a second identical model call; a `trigger: 'user'` click always goes through so a failed first run can be retried.
- **Readiness** is scored locally by `readinessScore()` (`READINESS_MAX === 100`); the model supplies only the `why` prose for unmet checks, so ticking the diagnostics box moves the bar with no round trip. Three checks — description (45, or 25 part-marks), context (35), diagnostics (20) — and they apply to every report, so the denominator is fixed and there is no longer a per-kind rescale. It is advice — submitting at 20% is allowed.
- **Tracking (`src/services/reportTrackingService.ts`, `src/providers/MyReportsTreeProvider.ts`)** — the handle comes from a **silent** `getSession('github', ['read:user'], { silent: true })`; with no session the **My Reports** view simply does not appear and nobody is prompted. Because the issue is filed in the user's browser, `recordPending()` records the moment the form opened and a later unauthenticated `GET /search/issues` reconciles by normalised title. The service owns its own `erdStudio.hasTrackedReports` context key. `shippedIn` comes from `milestone.title` or a `shipped-in:<v>` label — never a guess — and one notification fires per newly shipped report.
- Pure helpers (`formatDiagnostics`, `buildIssueUrl`, `composeFeedbackFields`, `composeMarkdownReport`, `ErrorLog`, `trackedReportLabel`, `reconcileReports`, `parseAnalysisResponse`) have no VS Code dependency and are unit-tested.

## Key Conventions

- **Schema changes must update harness content AND bump `HARNESS_VERSION`** — the domain JSON schema (model structure, column fields, relationships, viewConfig, naming conventions) is embedded as a string constant in `src/services/harnessService.ts` (`SCHEMA_CONTENT`). When you change the domain file schema (e.g. add/remove/rename fields in `packages/core/src/types/semantic.ts`, change file layout, update naming conventions), you **must**: (1) update the `SCHEMA_CONTENT` constant, (2) update the format-specific generators if needed (`generateClaudeSkill`, `generateCopilotInstructions`, `generateGeminiStyleguide`, `generateCodexAgents`), (3) **bump the `HARNESS_VERSION` constant** in the same file, and (4) keep `docs/semantic-domain-json-reference.md` in sync. See "Harness Versioning" below.
- Shared types live in `src/types/` and are included in both tsconfigs; `src/services/nameUtils.ts` and `src/workers/manifestExtractor.ts` must stay free of `vscode` imports (bundled into the worker and `mcp-server`)
- Webview components use BEM CSS class naming
- All colours use CSS custom properties from `packages/renderer/src/styles/theme.css`
- React Flow custom node/edge types must be defined as stable references (module-level constants, not inside components)
- **Every canvas edit to a domain file or a `logical-models/*.yml` goes through `applyDomainEdit`'s single `WorkspaceEdit`** — one undo step, and nothing reaches disk unless `applyEdit` succeeds. Direct `fs` writes still exist elsewhere (`LogicalModelService.saveModel` for non-editor callers, `LayerService.saveConfig`, `HarnessService`, `MigrationService`, `LegacyTagCleanupService`, sync-plan and bug-report output, and `createDomain`'s `wx` create); the rule is about the editor path, not a repo-wide ban. Writers whose file is watched (domain JSON, `layers.json`, `logical-models/*.yml`) must record `ownWrites` so the watcher does not bounce the write back as a refresh
- ELK worker code is injected at build time via `define` — VS Code webviews cannot use `importScripts()`
- Stage switching sends `switchStage`; the extension responds with `stageData` (physical is derived on demand, never persisted; positions inherited from logical)
- Mutation handlers target model bodies through `applyModelEdit` (v5 yml) and `parsed.logical.models` / `.relationships` in the domain file; `updateColumn` treats omitted `scdType`/`additiveType` as "keep" and `null` as "clear"
- Model names must match `MODEL_NAME_PATTERN` (`/^[a-z][a-z0-9_]*$/`); Add/Rename refuse names already present in the model library
- `SelectorsService` only owns `domain_*` selectors whose description ends with `Managed by ERD Studio.`; everything else in `selectors.yml` is preserved
- Host `error` messages render as a dismissable toast over a live canvas; the full-screen error page (with Retry / Send Feedback) is reserved for initial-load failure
- Put user-facing release notes under `## Unreleased` in `CHANGELOG.md` as part of every PR (the deploy workflow stamps the version)

## Code Review Checklist

Rules reviewers (human or AI) apply to every PR — the former `REVIEW.md` is archived under `docs/archive/`:

- Domain/model writes go through `applyDomainEdit` / `applyModelEdit` — reject hand-rolled `WorkspaceEdit`s or direct `fs` writes in the provider
- Physical stage is derived at runtime: reject code that persists physical data, copies logical relationships into physical, or extends the physical allowlist with schema mutations
- Message protocol changes update both directions in `src/types/messages.ts`, add payload validation, and wire both a sender and a handler
- Schema changes update `SCHEMA_CONTENT`, bump `HARNESS_VERSION` and update the reference doc
- `erdStudio` identifiers only; the `dbtSemantic` aliases and deprecated settings stay; settings read via `getErdStudioSetting()`
- No `vscode` imports in worker-shared modules; no APIs newer than VS Code 1.85
- Webview: BEM classes, theme CSS variables (no hardcoded colours), module-level node/edge type maps, `useSend()` rather than `useMessageBus(() => {})`
- Skip: lock-file formatting, `test/fixtures/` sample data, deploy-workflow version bump commits

## Discrepancy System

Cross-stage comparison is handled by `DiscrepancyService.compare(source, target)`:

| Active Stage | Available Comparisons |
|-------------|----------------------|
| Physical | Compare to Logical |
| Logical | Compare to Physical |

Discrepancy statuses for models/columns/relationships: `matched`, `extra`, `missing`, `type-mismatch` and `undeclared` (columns), `cardinality-mismatch` (relationships). `undeclared` is the case where exactly one stage declares a data type at all — it gets its own status and its own `summary.undeclaredColumns` count rather than inflating the mismatch count, and `deriveColumnAction` still resolves it like a mismatch so "write `data_type:` into the yml" stays reachable. Ghost nodes appear for missing models. Two suppressions, with different switches: the domain's `stubColumns` list is the user's own, and hides missing-column discrepancies only; separately `compare()` automatically drops models with `existsInProject === false` from both sides (and from `summary.totalModels`), and reports a model whose only evidence is a source file (`columns: []` and `provenance.columns === ['file']`) as `matched` with no column rows, on either side — otherwise one undocumented model would emit its counterpart's whole column list as differences. Type comparison splits a base from its parameters with a matched-delimiter scan (so `timestamp(6) without time zone` and `STRUCT<a INT64>` both keep their real base), canonicalises the spellings adapters actually emit (`character varying` → `string`, `NUMBER`/`numeric` → `decimal`, `INT64` → `int`, `TIMESTAMP_NTZ` → `timestamp`, `TIMESTAMP_LTZ` → `timestamptz`), treats absent parameters on either side as compatible, and has exactly one cross-family rule: a whole-number decimal matches an integer. Sync plans are written to `.erd-studio/.sync-plan.json` by `generateSyncPlan`; **Execute with Claude** confirms the exact terminal command before launching.

## Harness Versioning

AI coding harness files (installed via `erdStudio.installCodingHarness`) embed a version marker to track staleness:

```
<!-- erd-studio-harness: 18 -->
```

**Key components in `src/services/harnessService.ts`:**

| Export | Purpose |
|--------|---------|
| `HARNESS_VERSION` | Current version string — bump when `SCHEMA_CONTENT` or generators change |
| `extractHarnessVersion(content)` | Parses version from file content, returns `null` if no marker |
| `detectStale(workspaceRoot)` | Returns installed `HarnessTarget[]` whose embedded version ≠ `HARNESS_VERSION`. Files with **no** marker are unmanaged (hand-written) and are never reported |
| `CODEX_REGION_BEGIN` / `CODEX_REGION_END` | `<!-- BEGIN/END erd-studio-harness -->` markers wrapping the ERD section in `AGENTS.md`; updates replace only this region |
| `findCodexRegion(content)` / `mergeCodexContent(existing, generated)` | Locate / splice the managed `AGENTS.md` region (falls back to heading…version-marker for pre-v16 installs, appends when absent) |

Generated paths honour `erdStudio.semanticDir` (SKILL/SYNC content, the Claude PreToolUse hook, Copilot `applyTo`, Gemini, Codex).

**Activation flow** (`src/extension.ts`): on startup, `detectStale()` runs. If stale targets are found, a warning notification offers "Update All" (updates immediately), "Choose…" (opens the install QuickPick with outdated targets pre-selected), or "Dismiss". Nothing is ever overwritten silently, unmanaged files are never flagged, and `AGENTS.md` content outside the BEGIN/END region is always preserved. When no harness files exist at all, the install QuickPick is offered once per workspace (tracked in `workspaceState`). The QuickPick labels existing unmanaged files honestly ("will be replaced" / "section will be appended").

**When to bump `HARNESS_VERSION`:** any change to `SCHEMA_CONTENT`, the generator functions, or naming conventions that would make previously installed harness files incorrect. Do **not** bump for unrelated extension changes — the version is independent of `package.json` version.

## Developer Testing in VS Code

To test the extension in development mode, open the **fixture dbt project** as the workspace.

### From the terminal (preferred)

Build first, then launch the Extension Development Host directly with the fixtures project:

```bash
npm run build
code --extensionDevelopmentPath=/Users/liamwynne/GIT/LIAM/erd-studio /Users/liamwynne/GIT/LIAM/erd-studio/test/fixtures/dbt-project
```

This opens the Extension Development Host with the fixtures project loaded and the extension active — no need to manually open a folder.

### From VS Code (alternative)

1. Open the extension project in VS Code
2. Press **F5** to launch the Extension Development Host
3. In the dev host, open `test/fixtures/dbt-project` as the workspace folder

**Note:** F5 runs the `npm: watch` pre-launch task. If it hangs, terminate running tasks first (**Cmd+Shift+P** → "Tasks: Terminate Task"), then retry.

### Using the fixtures

- The sidebar tree shows domains under Silver and Gold layers; the Model Library view lists `logical-models/`, grouped by folder
- Open **showcase** for the richest sample data (multiple models with relationships across the customer/order domain)
- Extension host `console.log` output appears in the **Debug Console** (Cmd+Shift+Y) of the main VS Code window (only when launched via F5)

This fixture project contains `dbt_project.yml`, a `target/manifest.json`, layer config, templates, and several domain files across silver/gold layers.

## Testing the Webview UI in Chrome

The webview runs inside VS Code's sandboxed iframe, making it hard to inspect visually. Use this workflow to render the full webview in a regular Chrome tab using browser automation tools.

### How it works

The built `dist/webview.js` is a self-contained IIFE bundle (React, React Flow, all components). The only external dependency is `acquireVsCodeApi()` which VS Code injects. By mocking that function and providing VS Code CSS variables, the entire webview renders in a plain browser.

### Steps

1. **Build the webview:**
   ```
   npm run build
   ```

2. **Create `dev-preview.html`** in the project root (gitignored):
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <title>Webview Dev Preview</title>
     <link rel="stylesheet" href="dist/webview.css">
     <style>
       html, body, #root { margin: 0; padding: 0; width: 100%; height: 100vh; overflow: hidden; }
       :root {
         --vscode-editor-background: #1e1e1e;
         --vscode-editor-foreground: #d4d4d4;
         --vscode-sideBar-background: #252526;
         --vscode-panel-border: #404040;
         --vscode-editorGroup-border: #444444;
         --vscode-button-background: #0e639c;
         --vscode-button-foreground: #ffffff;
         --vscode-button-hoverBackground: #1177bb;
         --vscode-input-background: #3c3c3c;
         --vscode-input-foreground: #cccccc;
         --vscode-input-border: transparent;
         --vscode-focusBorder: #007fd4;
         --vscode-editor-selectionBackground: #264f78;
         --vscode-errorForeground: #f48771;
         --vscode-editorWarning-foreground: #cca700;
         --vscode-descriptionForeground: #999999;
         --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         --vscode-font-size: 13px;
         --vscode-font-weight: 400;
         --vscode-editor-font-family: 'SF Mono', Menlo, Consolas, monospace;
       }
     </style>
   </head>
   <body>
     <div id="root"></div>
     <script>
       window.acquireVsCodeApi = function() {
         return {
           postMessage: function(msg) {
             if (msg && msg.type === 'ready') {
               setTimeout(function() {
                 window.postMessage({
                   type: 'domainLoaded',
                   payload: {
                     schemaVersion: 5, domain: 'preview', layer: 'silver',
                     stage: 'logical',
                     description: 'Dev preview', models: [], relationships: [],
                     viewConfig: {}, readOnly: false
                   }
                 }, '*');
               }, 100);
             }
           },
           getState: function() { return null; },
           setState: function() {}
         };
       };
     </script>
     <script src="dist/webview.js"></script>
   </body>
   </html>
   ```

3. **Serve locally and open in Chrome:**
   ```
   npx http-server -p 8765 --cors -c-1 &
   ```
   Then navigate to `http://localhost:8765/dev-preview.html`

4. **Add test models/relationships** to the `domainLoaded` payload in `dev-preview.html` to render sample nodes and edges. The graph transformer converts `DisplayDomain` data into React Flow nodes/edges automatically.

5. **Use Chrome browser automation** (claude-in-chrome) to take screenshots and verify visual output.

### Important notes

- `dist/webview.css` is a **separate file** from `dist/webview.js` — both must be loaded
- The mock `acquireVsCodeApi` sends a fake `domainLoaded` message so the app gets past the loading guard
- The `<style>` block provides VS Code dark theme CSS variables — adjust for light theme testing
- Remember to `npm run build` after any code changes before refreshing the preview
- Clean up mock data and `dev-preview.html` before committing (`dev-preview.html` is also excluded from the package by `.vscodeignore`)

## Publishing to VS Code Marketplace

**Marketplace:** https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio

The old `liamwynne.dbt-semantic-designer` extension has been unpublished and removed from the marketplace. Only `liamwynne.erd-studio` exists now.

### Versioning (Semantic Versioning)

Every released artifact follows [SemVer 2.0](https://semver.org), `MAJOR.MINOR.PATCH`, and each has its own version:

| Artifact | Version lives in | Who bumps it | Released by |
|---|---|---|---|
| VS Code extension | root `package.json` `version` | `deploy.yml` on merge (you choose the level in `CHANGELOG.md`) | `deploy.yml` (Marketplace + Open VSX + GitHub Release) |
| `@erd-studio/core` | `packages/core/package.json` | you, in the PR that changes the package | `npm publish`, by hand, after merge |
| `@erd-studio/renderer` | `packages/renderer/package.json` | you, in the PR that changes the package | `npm publish`, by hand, after merge |
| Harness files | `HARNESS_VERSION` | you (see "Harness Versioning") | the extension |
| Domain file format | `schemaVersion` / `CURRENT_SCHEMA_VERSION` | you, with a migration | the extension |

**Extension: pick the level by what users experience, not by how much code changed.**
- **PATCH** (the default, nothing to do): bug fixes, performance, internal refactors, dependency bumps and anything users can't see. Moving code into the packages was a patch: v1.0.11 carried the renderer/core extraction.
- **MINOR**: a new backwards-compatible capability, such as a new command, setting, canvas feature, MCP tool or supported dbt feature. Pin it in the changelog heading, e.g. `## Unreleased — 1.1.0`.
- **MAJOR**: anything that breaks existing users, for example:
  - dropping support for a domain `schemaVersion` or requiring a migration;
  - removing or renaming commands or settings;
  - raising `engines.vscode`;
  - changing the on-disk file layout.
  Pin it (`## Unreleased — 2.0.0`) and explain the upgrade path in the notes.
- Never edit the root `version` by hand in a PR; the workflow owns it. A pin only moves the version forward, and resets to patch bumps after it ships.
- Group user-facing notes under `### Added` / `### Changed` / `### Fixed` / `### Removed` ([Keep a Changelog](https://keepachangelog.com)). A PR with nothing user-visible may leave `## Unreleased` empty; the workflow then records the PR title.

**Packages: pick the level by their public API**, meaning every export of each entry point, `ErdCanvas` props, exported types and the `DisplayDomain` shape.
- **While `0.x`** (now): a breaking change bumps **MINOR** (`0.1.x → 0.2.0`), and everything else bumps PATCH. Go to `1.0.0` once the API is stable and has an outside consumer. After that, use normal SemVer (breaking = MAJOR).
- Bump the version in the same PR as the change. `@erd-studio/renderer` pins `@erd-studio/core` **exactly**, so a core release that the renderer needs also bumps the renderer's dependency (and the root `package.json` dependency) and the renderer's own version.
- A PR that changes only extension code doesn't bump the packages. A package change that ships in the extension still gets an extension release through `deploy.yml`, because the extension bundles the packages from source.
- **Publishing is manual and separate from `deploy.yml`.** After the PR merges, work from a clean `main`:
  1. `npm ci && npm run build:packages && npm test`.
  2. Publish in dependency order: `npm publish -w @erd-studio/core`, then `npm publish -w @erd-studio/renderer`. `prepack` rebuilds `dist`, and `publishConfig.access` is `public`.
  3. Tag each published version: `git tag @erd-studio/core@<v> && git tag @erd-studio/renderer@<v> && git push --tags`.
- Never unpublish or overwrite a published version. Fix forward with a new PATCH, and `npm deprecate` a bad release.
- Consumers pin exact versions and bump them deliberately.

### Publish a New Version

Releases normally happen automatically: `.github/workflows/deploy.yml` runs when a PR is merged to `main` (docs-only, `test/fixtures/**` and `.planning/**` PRs are skipped via `paths-ignore`, because every release triggers a save-all + window reload for users with a canvas open). It type-checks, builds and tests, computes the next version via `scripts/release.mjs next-version` — max(`package.json`, latest marketplace version) + patch by default, or the exact version pinned in the `## Unreleased` heading when that heading names one (`## Unreleased — 1.0.0`) and it is ahead of everything published; falls back to `package.json` if `vsce show` fails, stamps the `## Unreleased` section of `CHANGELOG.md` with that version, **commits and pushes the bump before publishing** (with rebase retries), then runs `vsce package --no-dependencies` + `vsce publish`, and publishes the **same** VSIX to [Open VSX](https://open-vsx.org/extension/liamwynne/erd-studio) (`ovsx publish`, namespace `liamwynne`, secret `OVSX_PAT`). The Open VSX step is `continue-on-error`: the Marketplace is the primary registry and an Open VSX failure must never block the release or the GitHub Release. Claude PR approval is checked but only soft-enforced (a warning). Put user-facing release notes under `## Unreleased` in `CHANGELOG.md` as part of your PR.

Manual publishing (rare) must follow the same order so `main` never falls behind the marketplace:

**IMPORTANT: Always bump `version` in `package.json` before publishing.** The marketplace rejects re-publishing an existing version number — check the latest published version first with `npx @vscode/vsce show liamwynne.erd-studio --json | jq -r '.versions[0].version'`.

1. Bump `version` in `package.json` (`node scripts/release.mjs next-version --marketplace-json <(npx @vscode/vsce show liamwynne.erd-studio --json)` prints the right one) and update `CHANGELOG.md`
2. Commit the version bump and push
3. Package and publish (two-step is more reliable than single-step; `--no-dependencies` because esbuild bundles every runtime dependency into `dist/`):
   ```bash
   source .env && npx @vscode/vsce package --no-dependencies -o erd-studio.vsix && npx @vscode/vsce publish --packagePath erd-studio.vsix --pat "$AZURE_PAT" && npx ovsx publish --packagePath erd-studio.vsix --pat "$OVSX_PAT" && rm erd-studio.vsix
   ```

`npx @vscode/vsce ls --no-dependencies` shows exactly what will ship; CI fails if it lists more than 60 files. `.vscodeignore` excludes everything except `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `media/` icons and `dist/`.

PATs are stored in `.env` as `AZURE_PAT` (Marketplace) and `OVSX_PAT` (Open VSX, also a GitHub Actions secret). The Azure PAT **must** be scoped to "All accessible organizations" (not a single org) — the marketplace sits outside any specific Azure DevOps org.

### Unpublish an Extension

```bash
source .env && npx @vscode/vsce unpublish <publisher>.<extension-id> --pat "$AZURE_PAT" --force
```
