# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Naming

The extension display name is **ERD Studio** (package name `erd-studio`, publisher `liamwynne`).

### Directory Structure

ERD Studio uses a **central model store** (domain schema v5). Model definitions are one YAML file per model in `.erd-studio/logical-models/`; domain JSON files at `.erd-studio/{layer}/{domain}.json` reference models **by name string** and hold relationships plus canvas layout. The custom editor activates for files matching `**/.erd-studio/*/*.json` (and the pre-0.6.44 `**/erd-studio/*/*.json` location, which activation renames in place).

The base directory is configurable via the `erdStudio.semanticDir` setting (default: `.erd-studio`).

```
.erd-studio/
├── layers.json
├── templates/
├── logical-models/          ← one YAML per model, shared across domains
│   ├── dim_customer.yml
│   └── fct_order.yml
├── silver/
│   ├── customer-360.json    ← domain file: logical.models = ["dim_customer", …]
│   └── orders.json
└── gold/
    └── reporting.json
```

File format detection is centralised in `detectDomainFormat()` (`src/types/semantic.ts`) → `v5` | `v4` (inline models, loads but prompts for `erdStudio.migrateToV5`) | `hybrid` / `legacy` (rejected with an error naming the migration command; `MigrationService` repairs both). Never add a second detector. The full on-disk contract is in `docs/semantic-domain-json-reference.md`; the copy shipped to AI assistants is `SCHEMA_CONTENT` in `src/services/harnessService.ts`.

### Internal Identifiers

All internal identifiers use the `erdStudio` prefix (`erd-studio` for the activity bar container id), with the command palette category `"ERD Studio"`. The extension was originally published with a `dbtSemantic` prefix; two compatibility shims keep pre-rename users working and must **not** be removed:

- **Legacy command aliases**: every pre-rename `erdStudio.*` command is also registered in code as `dbtSemantic.*` (see `LEGACY_ALIASED_COMMANDS` at the end of `activate()` in `src/extension.ts`) so old keybindings keep working. These are code-only registrations — never contribute them in package.json. Commands added after the rename (`erdStudio.reportBug`) get no alias.
- **Legacy setting fallback**: settings are read via `getErdStudioSetting()` (`src/services/configService.ts`), which prefers explicit `erdStudio.*` values and falls back to explicit `dbtSemantic.*` values. The deprecated `dbtSemantic.projectPath` / `dbtSemantic.semanticDir` entries in package.json carry `markdownDeprecationMessage` and must stay contributed. Never read settings with `getConfiguration('erdStudio').get(...)` directly — always use the helper.

### Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `erdStudio.projectPath` | `""` | dbt project root (absolute, or relative to a workspace folder). Auto-detected when empty. Change requires a window reload (the extension prompts). |
| `erdStudio.semanticDir` | `.erd-studio` | ERD data directory relative to the project root. Change requires a window reload (prompted). |
| `erdStudio.claudeSync.skipPermissions` | `false` | Pass `--dangerously-skip-permissions` when **Execute with Claude** launches Claude Code for a sync plan. The launch command is always confirmed in a modal first. |

## Build & Test Commands

```bash
npm run build          # Build extension, webview and manifest-worker bundles (esbuild)
npm run watch          # Watch mode — rebuilds on change
npm run compile        # Type-check only (both tsconfigs, no emit)
npm run test           # Run unit tests (vitest)
npm run test:watch     # Run tests in watch mode
npm run package        # Production build (minified, no sourcemaps)
```

Single test file: `npx vitest run test/unit/domainService.test.ts`

Tests use vitest with `vscode` module aliased to `test/__mocks__/vscode.ts` (a stateful mock: `inspect()`-backed configuration via `_setMockConfiguration`, in-memory `WorkspaceEdit`/`applyEdit`, command registry that throws on duplicate ids, `_simulateMessage` for webview messages). `test/globalSetup.ts` builds `dist/manifestWorker.js` before the run so manifest tests pass on a fresh clone. Fixture dbt projects live in `test/fixtures/` (`dbt-project` is the main one; `dbt-project-modern-tests` covers `data_tests:` / `arguments:` / versioned refs; the `-empty-manifest`, `-malformed`, `-sparse`, `-zero-byte` variants cover manifest edge cases).

CI (`.github/workflows/ci.yml`) runs on every PR: `npm audit --omit=dev --audit-level=high`, compile, build, test, package, and fails if `vsce ls --no-dependencies` lists more than 60 files. A second job type-checks, builds and smoke-tests `mcp-server/` (which imports `src/services/*` and bundles `src/workers/manifestWorker.ts` — an accidental `import 'vscode'` in a shared service fails there).

## Architecture

VS Code extension with three esbuild targets (`esbuild.js`):
- **Extension host** (Node.js, CJS) — `src/` → `dist/extension.js`
- **Webview** (Browser, IIFE with React) — `webview/` → `dist/webview.js` + `dist/webview.css`
- **Manifest worker** (Node.js worker thread) — `src/workers/manifestWorker.ts` → `dist/manifestWorker.js`

Two TypeScript configs: `tsconfig.json` (Node.js) and `tsconfig.webview.json` (DOM). The webview tsconfig includes `src/types/**/*` so types are shared. `@types/vscode` is pinned to `1.85.0` to match `engines.vscode` — do not use newer APIs.

### Two-Stage Architecture

The extension uses two design stages, each with a distinct purpose:

| Stage | Color | Purpose | Storage |
|-------|-------|---------|---------|
| **Logical** | Blue (`#60a5fa`) | Detailed data model — full columns, data types, PK/FK/NK, SCD types, grain, rationale | `logical-models/*.yml` (model bodies) + `logical` section of the domain file (model names, relationships) |
| **Physical** | Green (`#22c55e`) | What exists in dbt — logical models resolved per model from schema `.yml` files (preferred) or the manifest (fallback); relationships & cardinality derived from the union of yml and manifest test declarations; schema is read-only | Derived at runtime, no file on disk |

Stage colors are defined in `webview/lib/stageColors.ts`.

### Data Flow

```
{layer}/{domain}.json ─┐
logical-models/*.yml  ─┴→ DomainService.getDomain() ─→ UnifiedDomain ─→ .logical → DisplayDomain
                                                                                        │
schema .yml   ─→ YmlParserService ─┐                                                    │
manifest.json ─→ ManifestService  ─┴→ buildPhysicalDomain() ─→ DisplayDomain            │
                                                                                        │
                                                    [message] ─→ graphTransformer ─→ React Flow
```

1. **ManifestService** parses `{target-path}/manifest.json` in a worker thread (`dist/manifestWorker.js`, plain `JSON.parse` — there is no streaming parser or `stream-json` dependency) so 40MB+ files do not block the extension host. `src/workers/manifestExtractor.ts` (pure, shared with tests) extracts model nodes, relationship test nodes (`relationships`, `relationships_where`, custom), `unique` tests and `unique_combination_of_columns` tests, resolving dbt versioned models (`model.proj.name.vN`, `ref('m', v=N)`) to the latest version. A missing manifest is definitive (`ManifestMissingError`, `isMissing` flag); a malformed one is treated as transient (dbt mid-write) and the last known good result is served with `isStale`. Runaway parses are abandoned after `DEFAULT_PARSE_TIMEOUT_MS`.
2. **DbtProjectConfig** (`src/services/dbtProjectConfig.ts`) reads `target-path` / `model-paths` from `dbt_project.yml` once at activation; ManifestService, YmlParserService, FileWatcherService and the staleness check all use those paths rather than hard-coded `target/` and `models/`.
3. **DomainService** reads a domain JSON → `UnifiedDomain`, resolving each model name through **LogicalModelService** (`logical-models/{name}.yml`, parsed with `yaml` `parseDocument` and written back by editing that same document in place, so comments, key order and unknown keys survive every UI write — including a canvas rename, which carries the old file's document across via `serializeModel(model, fromName)`. Two exceptions: a file that fails to parse is regenerated from scratch, and folded `>` block scalars are re-emitted on one line, value unchanged. A missing file renders as a placeholder with a warning), then extracts a stage section via `getDomainStage()` → `DisplayDomain`. Malformed `viewConfig.positions` entries and relationships missing endpoints are dropped with a console warning.
4. For physical stage: `DomainService.buildPhysicalDomain(unified, ymlData, manifest)` resolves each logical model from the dbt schema `.yml` files (**YmlParserService**, preferred because it is always current) or, per model, falls back to the manifest — a model missing from yml but present in the manifest still appears. Models in neither source are omitted. Columns come from whichever source resolved the model, with data types enriched from the manifest. **Relationships are derived from the union of yml and manifest relationship tests** (deduped; never copied from logical). Cardinality is inferred from `unique`/`unique_combination_of_columns` tests merged from both sources (no unique test = "many" side). Model and column names are matched case-insensitively (`normaliseName()` in `src/services/nameUtils.ts`). Relationships are scoped to models within the domain to prevent conformed dimensions from pulling in external edges. See `derivePhysicalRelationships()` in `domainService.ts`. YmlParserService walks only the configured model paths (skipping `dbt_packages`, `dbt_modules`, venvs), reads both `tests:` and `data_tests:` keys, `unique` as a scalar or map form, and dbt 1.10 `arguments:` nesting; both parsers accept versioned `ref('model', v=2)`.
5. **DiscrepancyService** compares two `DisplayDomain` objects (case-insensitive keys, raw names preserved on the report) to produce a `DiscrepancyReport`
6. Extension sends `domainLoaded` / `stageData` message to webview
7. **graphTransformer** converts `DisplayDomain` → React Flow nodes + edges (with optional discrepancy overlays); `nodeOverlays.applyNodeOverlays` layers dimming/expansion on top with identity preservation so memoised nodes skip re-rendering
8. **elkLayout** runs ELK auto-layout in a Web Worker (injected at build time as `__ELK_WORKER_CODE__`; 30 s timeout, failures surface as a toast)

### Extension Host (`src/`)

| Directory | Purpose |
|-----------|---------|
| `extension.ts` | Activation: dbt project detection, command registration, harness update prompt, watchers wiring, legacy aliases |
| `providers/` | `SemanticEditorProvider` (custom editor), `DomainTreeProvider` / `ModelLibraryTreeProvider` (sidebar trees), decoration providers, `payloadValidation.ts` (runtime checks for webview payloads) |
| `services/` | Business logic — `manifestService`, `ymlParserService`, `domainService`, `logicalModelService` (yml model store), `migrationService` (v4→v5, legacy dir rename), `discrepancyService`, `layerService`, `templateService`, `selectorsService`, `harnessService`, `feedbackService` (Report a Bug), `dbtProjectConfig`, `ownWriteTracker`, `configService`, `nameUtils`, `stalenessService`, `recoveryService`, `positionService`, `legacyTagCleanupService` |
| `watchers/` | `FileWatcherService` — debounced (300 ms) watchers for manifest, domain files, `layers.json`, `logical-models/`, `dbt_project.yml` |
| `workers/` | `manifestWorker.ts` (worker entry) and `manifestExtractor.ts` (pure extraction, also used by `mcp-server/`) |
| `types/` | Shared type definitions (imported by both host and webview), incl. `naming.ts` (`MODEL_NAME_PATTERN`, `COLUMN_NAME_PATTERN`) |

### Webview (`webview/`)

| Directory | Purpose |
|-----------|---------|
| `components/` | React components — `Graph/` (ModelNode, FkEdge), `DetailPanel/`, `DiscrepancyPanel/`, `WelcomeModal/`, `Toolbar/` (StageTabs), `BugReportDialog/`, `Toast/`, dialogs |
| `store/` | Zustand store (`editorStore.ts`) — UI state, selection, dialogs, active stage, discrepancy, toast/error, bug-report dialog |
| `hooks/` | `useMessageBus` (extension comms; `useSend()` for a stable sender), `useVsCodeApi`, `useCanvasShortcuts` (global keydown — reads store via `getState()`, registered once), position/state persistence (flushed on `visibilitychange`/`pagehide`) |
| `lib/` | Pure functions — `graphTransformer`, `nodeOverlays`, `elkLayout`, `edgeDistribution`, `stageColors`, `keyboardShortcuts`, `stageRequest`, `screenshot` (html-to-image capture for bug reports) |
| `styles/` | `theme.css` — CSS custom properties mapping VS Code theme vars |

### Message Protocol (`src/types/messages.ts`)

Extension <-> Webview communication uses discriminated unions on `type` field:
- **Extension -> Webview**: `domainLoaded`, `stageData`, `discrepancyReport`, `manifestStaleness`, `syncPlanGenerated`, `openBugReport`, `error`
- **Webview -> Extension**:
  - lifecycle/navigation: `ready`, `dismissWelcome`, `viewFile`, `requestReload`, `switchStage`, `refreshManifest`, `undo`, `redo`
  - schema mutations: `addModel`, `addExistingModel`, `renameModel`, `removeModel`, `removeModels`, `addColumn`, `removeColumn`, `updateColumn`, `reorderColumns`, `toggleColumnKey`, `updateModelDescription`, `updateModelGrain`, `updateModelRole`, `updateModelRationale`, `addRelationship`, `updateRelationship`, `editRelationship`, `removeRelationship`, `removeRelationships`
  - canvas metadata: `updatePositions`, `addAnnotation`, `updateAnnotation`, `removeAnnotation`, `removeAnnotations`
  - sync/discrepancy: `toggleDiscrepancy`, `generateSyncPlan`, `runDbtCompile`, `launchClaudeSync`
  - feedback: `reportBug`

Every type in the unions has a live sender and handler — do not add a message type without wiring both ends (unknown types are logged by the `default:` branch, never silently dropped). Multi-select operations are batched: `removeModels`, `removeAnnotations`, `removeRelationships` and `updatePositions` (which carries `annotations?: [{id,x,y}]` for notes moved in the same drag) each produce **one** `WorkspaceEdit`, one save, one `domainLoaded` — i.e. one undo step. `switchStage` carries a `requestId` that the host echoes on `stageData` so the webview can drop stale replies (`webview/lib/stageRequest.ts`).

**Physical stage guard.** While a panel is viewing the physical stage the host rejects every message not in this allowlist with a `"Physical stage is read-only"` `error`:

```
ready, updatePositions, switchStage, toggleDiscrepancy, refreshManifest, dismissWelcome,
viewFile, generateSyncPlan, runDbtCompile, launchClaudeSync,
addAnnotation, updateAnnotation, removeAnnotation, removeAnnotations, requestReload, reportBug
```

Positions and annotations are allowed because they live in the shared `viewConfig` (physical inherits logical positions); `generateSyncPlan` is the physical-stage "Compare to Logical" flow. `undo`/`redo` are deliberately **not** allowed (the toolbar hides them there) — they would rewind the logical document under a derived view.

**Edit pipeline.** All domain-file writes go through `applyDomainEdit()` in `SemanticEditorProvider` — the only place a domain `WorkspaceEdit` is built: parse → mutate → replace whole document → `applyEdit` → `document.save()` → refresh, with `pendingUpdates` held so the change listener never double-saves. Edits are saved immediately; the custom editor never sits dirty. A mutator throws `EditAborted` to bail out after reporting its own error; pass `errorLabel` for the applyEdit-rejected case and `onSuccess` for follow-up work such as `selectorsService.scheduleRegenerate()`. `applyModelEdit()` routes `logical-models/*.yml` changes through the **same** `WorkspaceEdit` (`modelFiles: { save: [{ model, fromName? }], delete }`) so a model edit and its domain change are atomic and one undo step — never `fs.writeFileSync` a model file from a handler (`addExistingModel` seeds a new library file the same way, so a rejected edit leaves no orphan yml). `fromName` names the file whose existing YAML document supplies comments / key order / unknown keys: a rename passes the OLD name so hand-written content is carried to the new file instead of being regenerated. Every file the pipeline writes is recorded in `ownWrites` **after** the bytes land (the tracker stats the file), so the watchers skip our own saves; the refreshes they used to drive are issued directly instead — `sendDomainData` for the editing panel, `refreshDomainsReferencingModel(name, exceptPanelKey)` for other open panels, and the `onDidWriteDomain` event for the tree / model library views. An undo/redo flushes only the yml documents this provider itself wrote for that domain (`editedModelPaths`) — a model file the user is hand-editing in another tab is never force-saved. Payloads are validated at the message boundary by `src/providers/payloadValidation.ts` (model names via the shared `MODEL_NAME_PATTERN` in `src/types/naming.ts`, column lists incl. duplicates, `keyType`, `cardinality`, `modelRole`, finite positions); `LogicalModelService.modelPath` refuses names that escape `logical-models/`. The message listener is wrapped in `withMessageErrorBoundary()` so a throwing handler posts an `error` instead of becoming an unhandled rejection. Refresh paths (watchers, external edits, stage switches) never write — only the initial `ready` load persists auto-computed positions.

### Activation (`src/extension.ts`)

- **Project detection** — `resolveDbtProjectRoot()` honours `erdStudio.projectPath`, then workspace folder roots, then a depth-3 search for `dbt_project.yml` (skipping `node_modules`, `dbt_packages`, `.git`, `target`, venvs). With no project found, `registerFallbackCommands()` registers every contributed command (plus aliases) with a "no dbt project" warning and a stub custom editor, so nothing reports "command not found".
- **`erdStudio.reportBug`** is registered before any early return so it always works.
- **Update recovery** — if the extension version changed since last activation and a canvas is open, the host offers a save-all + window reload (`recoveryService`); the webview also detects orphaning and sends `requestReload`. The custom editor is registered with `retainContextWhenHidden`.
- **No unprompted writes** — activation may rename a legacy `erd-studio/` dir to `.erd-studio/` (with a notice) but otherwise writes nothing: `SelectorsService.regenerate()` returns `noop` when there is nothing to write, harness updates and v4→v5 migration always prompt.
- **Context keys** `erdStudio.hasSemanticDir` / `erdStudio.hasLogicalModelsDir` are refreshed by `refreshContextKeys()` after every relevant watcher event and command.
- **Settings changes** to `semanticDir` / `projectPath` (either prefix) prompt for a window reload.

### Watchers (`src/watchers/FileWatcherService.ts`)

Own writes are recorded in `ownWrites` (`src/services/ownWriteTracker.ts`, path + mtime/size, 5 s TTL) by `SemanticEditorProvider` (the editor write path — domain file, model yml saves, creates and deletes), `LogicalModelService`, `LayerService` and the `deleteDomain` command, and consumed in the callbacks that watch files the extension itself writes (domain `.json` changes and deletes, `layers.json`, `logical-models/*.yml`) so an extension save never triggers a second identical refresh. The manifest and `dbt_project.yml` callbacks have nothing to consume — the extension never writes those. `renameDomain` (`extension.ts`) is the one gap: its create+delete `WorkspaceEdit` records neither path, so the old file's delete is seen as external. `classifySemanticPath()` ensures only `{layer}/{domain}.json` fires `onSemanticFileDeleted` (coalesced to one `{ uris }` event per burst); `layers.json` has its own `onLayerConfigChanged`. `LayerService.loadConfig()` is mtime-validated and refuses to overwrite an unreadable/invalid `layers.json` (`getLoadError()`).

## Report a Bug

`erdStudio.reportBug` (palette, sidebar title bar, toolbar button, and the canvas error screen) opens a **prefilled GitHub issue form** (`.github/ISSUE_TEMPLATE/bug_report.yml`, repo `liam-machine/erd-studio`) via `vscode.env.openExternal`. Nothing is sent from the extension itself — the user reviews and submits on GitHub, so no token is needed.

- With a canvas active the host posts `openBugReport` (optional `{title, description}` prefill) and the webview's `BugReportDialog` collects title/description/steps, captures the canvas as PNG (`webview/lib/screenshot.ts`, `html-to-image`), copies it to the clipboard and posts `reportBug`. Without a canvas, two input boxes gather title and description.
- `feedbackService.submitBugReport()` appends diagnostics (extension/VS Code versions, OS, domain summary, recent host errors from `hostErrorLog` and webview errors) and builds the URL, truncating verbose fields to stay under `MAX_ISSUE_URL_LENGTH`. The screenshot is also saved under `globalStorage` with a "Reveal" action as a fallback (GitHub has no API for image attachments).
- Pure helpers (`formatDiagnostics`, `buildIssueUrl`, `ErrorLog`) have no VS Code dependency and are unit-tested.

## Key Conventions

- **Schema changes must update harness content AND bump `HARNESS_VERSION`** — the domain JSON schema (model structure, column fields, relationships, viewConfig, naming conventions) is embedded as a string constant in `src/services/harnessService.ts` (`SCHEMA_CONTENT`). When you change the domain file schema (e.g. add/remove/rename fields in `src/types/semantic.ts`, change file layout, update naming conventions), you **must**: (1) update the `SCHEMA_CONTENT` constant, (2) update the format-specific generators if needed (`generateClaudeSkill`, `generateCopilotInstructions`, `generateGeminiStyleguide`, `generateCodexAgents`), (3) **bump the `HARNESS_VERSION` constant** in the same file, and (4) keep `docs/semantic-domain-json-reference.md` in sync. See "Harness Versioning" below.
- Shared types live in `src/types/` and are included in both tsconfigs; `src/services/nameUtils.ts` and `src/workers/manifestExtractor.ts` must stay free of `vscode` imports (bundled into the worker and `mcp-server`)
- Webview components use BEM CSS class naming
- All colours use CSS custom properties from `webview/styles/theme.css`
- React Flow custom node/edge types must be defined as stable references (module-level constants, not inside components)
- **Every canvas edit to a domain file or a `logical-models/*.yml` goes through `applyDomainEdit`'s single `WorkspaceEdit`** — one undo step, and nothing reaches disk unless `applyEdit` succeeds. Direct `fs` writes still exist elsewhere (`LogicalModelService.saveModel` for non-editor callers, `LayerService.saveConfig`, `HarnessService`, `MigrationService`, `LegacyTagCleanupService`, sync-plan and bug-report output, and `createDomain`'s `wx` create); the rule is about the editor path, not a repo-wide ban. Writers whose file is watched (domain JSON, `layers.json`, `logical-models/*.yml`) must record `ownWrites` so the watcher does not bounce the write back as a refresh
- ELK worker code is injected at build time via `define` — VS Code webviews cannot use `importScripts()`
- Stage switching sends `switchStage`; the extension responds with `stageData` (physical is derived on demand, never persisted; positions inherited from logical)
- Mutation handlers target model bodies through `applyModelEdit` (v5 yml) and `parsed.logical.models` / `.relationships` in the domain file; `updateColumn` treats omitted `scdType`/`additiveType` as "keep" and `null` as "clear"
- Model names must match `MODEL_NAME_PATTERN` (`/^[a-z][a-z0-9_]*$/`); Add/Rename refuse names already present in the model library
- `SelectorsService` only owns `domain_*` selectors whose description ends with `Managed by ERD Studio.`; everything else in `selectors.yml` is preserved
- Host `error` messages render as a dismissable toast over a live canvas; the full-screen error page (with Retry / Report a Bug) is reserved for initial-load failure
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

Discrepancy statuses for models/columns/relationships: `matched`, `extra`, `missing`, `type-mismatch` (columns), `cardinality-mismatch` (relationships). Ghost nodes appear for missing models. Models listed in the domain's `stubColumns` suppress missing-column discrepancies only. Type comparison normalises common aliases (`varchar`/`string`, `int`/`integer`, …). Sync plans are written to `.erd-studio/.sync-plan.json` by `generateSyncPlan`; **Execute with Claude** confirms the exact terminal command before launching.

## Harness Versioning

AI coding harness files (installed via `erdStudio.installCodingHarness`) embed a version marker to track staleness:

```
<!-- erd-studio-harness: 16 -->
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

- The sidebar tree shows domains under Silver and Gold layers; the Model Library view lists `logical-models/`
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

### Publish a New Version

Releases normally happen automatically: `.github/workflows/deploy.yml` runs when a PR is merged to `main` (docs-only, `test/fixtures/**` and `.planning/**` PRs are skipped via `paths-ignore`, because every release triggers a save-all + window reload for users with a canvas open). It type-checks, builds and tests, computes the next version as max(`package.json`, latest marketplace version) + patch via `scripts/release.mjs next-version` (falling back to `package.json` if `vsce show` fails), stamps the `## Unreleased` section of `CHANGELOG.md` with that version, **commits and pushes the bump before publishing** (with rebase retries), then runs `vsce package --no-dependencies` + `vsce publish`. Claude PR approval is checked but only soft-enforced (a warning). Put user-facing release notes under `## Unreleased` in `CHANGELOG.md` as part of your PR.

Manual publishing (rare) must follow the same order so `main` never falls behind the marketplace:

**IMPORTANT: Always bump `version` in `package.json` before publishing.** The marketplace rejects re-publishing an existing version number — check the latest published version first with `npx @vscode/vsce show liamwynne.erd-studio --json | jq -r '.versions[0].version'`.

1. Bump `version` in `package.json` (`node scripts/release.mjs next-version --marketplace-json <(npx @vscode/vsce show liamwynne.erd-studio --json)` prints the right one) and update `CHANGELOG.md`
2. Commit the version bump and push
3. Package and publish (two-step is more reliable than single-step; `--no-dependencies` because esbuild bundles every runtime dependency into `dist/`):
   ```bash
   source .env && npx @vscode/vsce package --no-dependencies -o erd-studio.vsix && npx @vscode/vsce publish --packagePath erd-studio.vsix --pat "$AZURE_PAT" && rm erd-studio.vsix
   ```

`npx @vscode/vsce ls --no-dependencies` shows exactly what will ship; CI fails if it lists more than 60 files. `.vscodeignore` excludes everything except `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `media/` icons and `dist/`.

PAT is stored in `.env` as `AZURE_PAT`. The PAT **must** be scoped to "All accessible organizations" (not a single org) — the marketplace sits outside any specific Azure DevOps org.

### Unpublish an Extension

```bash
source .env && npx @vscode/vsce unpublish <publisher>.<extension-id> --pat "$AZURE_PAT" --force
```
