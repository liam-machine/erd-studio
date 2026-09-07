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

- **Legacy command aliases**: every pre-rename `erdStudio.*` command is also registered in code as `dbtSemantic.*` (see `LEGACY_ALIASED_COMMANDS` at the end of `activate()` in `src/extension.ts`) so old keybindings keep working. These are code-only registrations — never contribute them in package.json. Commands added after the rename get no alias — they are listed in the exported `NO_LEGACY_ALIAS` set in `src/extension.ts`, which `registerFallbackCommands()` consults and `test/unit/extension.activate.test.ts` mirrors.
- **Legacy setting fallback**: settings are read via `getErdStudioSetting()` (`src/services/configService.ts`), which prefers explicit `erdStudio.*` values and falls back to explicit `dbtSemantic.*` values. The deprecated `dbtSemantic.projectPath` / `dbtSemantic.semanticDir` entries in package.json carry `markdownDeprecationMessage` and must stay contributed. Never read settings with `getConfiguration('erdStudio').get(...)` directly — always use the helper.

### Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `erdStudio.projectPath` | `""` | dbt project root (absolute, or relative to a workspace folder). Auto-detected when empty. Change requires a window reload (the extension prompts). |
| `erdStudio.semanticDir` | `.erd-studio` | ERD data directory relative to the project root. Change requires a window reload (prompted). |
| `erdStudio.claudeSync.skipPermissions` | `false` | Pass `--dangerously-skip-permissions` when **Execute with Claude** launches Claude Code for a sync plan. The launch command is always confirmed in a modal first. |
| `erdStudio.feedback.aiAssist` | `true` | Master switch for the Feedback dialog's single AI analysis call. On by default: tier 1 is the user's own model behind VS Code's own consent dialog. Off means no tier resolves at all. |
| `erdStudio.feedback.endpoint` | `""` | Base URL of an OpenAI-compatible chat-completions API (tier 2). Empty means "use VS Code's language model if there is one". |
| `erdStudio.feedback.model` | `""` | Model id sent to `erdStudio.feedback.endpoint`. The API key lives in `context.secrets`, never in settings. |
| `erdStudio.feedback.hostedFallback` | `true` | Allow the last-resort hosted tier (tier 3). Inert while `HOSTED_ANALYSIS_ENDPOINT` is empty; `false` removes the tier even once it is not. |
| `erdStudio.feedback.trackReports` | `true` | Poll GitHub for issues the user filed and show them in **My Reports**. Needs a silent GitHub session; the view is hidden and nobody is prompted without one. |

`erdStudio.feedback.aiAssist`, `.endpoint`, `.model` and `.hostedFallback` are contributed with `"scope": "machine"` and are additionally listed in `USER_SCOPED_SETTINGS` (`src/services/configService.ts`), so `getErdStudioSetting()` reads **only** their global value. A repository's checked-in `.vscode/settings.json` must never be able to point the analysis request — and the API key from secret storage that travels with it — at a host of its author's choosing. Do not remove either half: the scope keeps the value out of `inspect()`, and the list is what makes that true for this codebase's hand-rolled precedence chain.

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

`proxy/` is a **fourth thing that is not part of the extension**: the Cloudflare Worker behind the feedback analysis fallback tier (`HOSTED_ANALYSIS_ENDPOINT`). It is deployed by hand from [`proxy/README.md`](proxy/README.md) — which is also where the operator's obligations are spelled out, since running it means processing other people's bug descriptions through a publicly reachable URL — it is listed in `.vscodeignore` so it never ships in the VSIX (CI fails above 60 files), and nothing in `esbuild.js`, the tsconfigs or the npm scripts may come to depend on it — `npm run build` and `npm test` must stay green in a clone that has never touched it. It has no dependencies and no build step: `proxy/src/index.js` is plain JavaScript that deploys as written, checked in place with `node --check` and the local `proxy/tsconfig.json` (`checkJs`), which the root build does not reference.

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
| `providers/` | `SemanticEditorProvider` (custom editor), `DomainTreeProvider` / `ModelLibraryTreeProvider` / `MyReportsTreeProvider` (sidebar trees), decoration providers, `payloadValidation.ts` (runtime checks for webview payloads) |
| `services/` | Business logic — `manifestService`, `ymlParserService`, `domainService`, `logicalModelService` (yml model store), `migrationService` (v4→v5, legacy dir rename), `discrepancyService`, `layerService`, `templateService`, `selectorsService`, `harnessService`, `feedbackService` (Send Feedback), `feedbackAnalysisService` (opt-in AI analysis), `reportTrackingService` (My Reports), `dbtProjectConfig`, `ownWriteTracker`, `configService`, `nameUtils`, `stalenessService`, `recoveryService`, `positionService`, `legacyTagCleanupService` |
| `watchers/` | `FileWatcherService` — debounced (300 ms) watchers for manifest, domain files, `layers.json`, `logical-models/`, `dbt_project.yml` |
| `workers/` | `manifestWorker.ts` (worker entry) and `manifestExtractor.ts` (pure extraction, also used by `mcp-server/`) |
| `types/` | Shared type definitions (imported by both host and webview), incl. `naming.ts` (`MODEL_NAME_PATTERN`, `COLUMN_NAME_PATTERN`) |

### Webview (`webview/`)

| Directory | Purpose |
|-----------|---------|
| `components/` | React components — `Graph/` (ModelNode, FkEdge), `DetailPanel/`, `DiscrepancyPanel/`, `WelcomeModal/`, `Toolbar/` (StageTabs), `FeedbackDialog/` (dialog, `AnalysisPanel`, `DuplicateTakeover`, `DiagnosticsChips`, `FeedbackFooter`), `Toast/`, dialogs |
| `store/` | Zustand store (`editorStore.ts`) — UI state, selection, dialogs, active stage, discrepancy, toast/error, feedback dialog (diagnostics, capabilities, analysis) |
| `hooks/` | `useMessageBus` (extension comms; `useSend()` for a stable sender), `useVsCodeApi`, `useCanvasShortcuts` (global keydown — reads store via `getState()`, registered once), position/state persistence (flushed on `visibilitychange`/`pagehide`) |
| `lib/` | Pure functions — `graphTransformer`, `nodeOverlays`, `elkLayout`, `edgeDistribution`, `stageColors`, `keyboardShortcuts`, `stageRequest`, `screenshot` (html-to-image capture + clipboard), `feedbackAttachments` (the captured canvas → the one `FeedbackAttachment`) |
| `styles/` | `theme.css` — CSS custom properties mapping VS Code theme vars |

### Message Protocol (`src/types/messages.ts`)

Extension <-> Webview communication uses discriminated unions on `type` field:
- **Extension -> Webview**: `domainLoaded`, `stageData`, `discrepancyReport`, `manifestStaleness`, `syncPlanGenerated`, `openFeedback`, `feedbackContext`, `feedbackAnalysis`, `feedbackSubmitted`, `error`
- **Webview -> Extension**:
  - lifecycle/navigation: `ready`, `dismissWelcome`, `viewFile`, `requestReload`, `switchStage`, `refreshManifest`, `undo`, `redo`
  - schema mutations: `addModel`, `addExistingModel`, `renameModel`, `removeModel`, `removeModels`, `addColumn`, `removeColumn`, `updateColumn`, `reorderColumns`, `toggleColumnKey`, `updateModelDescription`, `updateModelGrain`, `updateModelRole`, `updateModelRationale`, `addRelationship`, `updateRelationship`, `editRelationship`, `removeRelationship`, `removeRelationships`
  - canvas metadata: `updatePositions`, `addAnnotation`, `updateAnnotation`, `removeAnnotation`, `removeAnnotations`
  - sync/discrepancy: `toggleDiscrepancy`, `generateSyncPlan`, `runDbtCompile`, `launchClaudeSync`
  - feedback: `requestFeedbackContext`, `analyzeFeedback`, `submitFeedback`, `copyFeedbackReport`, `requestGithubSignIn`, `openFeedbackLink`

Every type in the unions has a live sender and handler — do not add a message type without wiring both ends (unknown types are logged by the `default:` branch, never silently dropped). Multi-select operations are batched: `removeModels`, `removeAnnotations`, `removeRelationships` and `updatePositions` (which carries `annotations?: [{id,x,y}]` for notes moved in the same drag) each produce **one** `WorkspaceEdit`, one save, one `domainLoaded` — i.e. one undo step. `switchStage` carries a `requestId` that the host echoes on `stageData` so the webview can drop stale replies (`webview/lib/stageRequest.ts`).

**Physical stage guard.** While a panel is viewing the physical stage the host rejects every message not in this allowlist with a `"Physical stage is read-only"` `error`:

```
ready, updatePositions, switchStage, toggleDiscrepancy, refreshManifest, dismissWelcome,
viewFile, generateSyncPlan, runDbtCompile, launchClaudeSync,
addAnnotation, updateAnnotation, removeAnnotation, removeAnnotations, requestReload,
requestFeedbackContext, analyzeFeedback, submitFeedback, copyFeedbackReport,
requestGithubSignIn, openFeedbackLink
```

Positions and annotations are allowed because they live in the shared `viewConfig` (physical inherits logical positions); `generateSyncPlan` is the physical-stage "Compare to Logical" flow; the six feedback types write no domain data at all. `undo`/`redo` are deliberately **not** allowed (the toolbar hides them there) — they would rewind the logical document under a derived view.

**Edit pipeline.** All domain-file writes go through `applyDomainEdit()` in `SemanticEditorProvider` — the only place a domain `WorkspaceEdit` is built: parse → mutate → replace whole document → `applyEdit` → `document.save()` → refresh, with `pendingUpdates` held so the change listener never double-saves. Edits are saved immediately; the custom editor never sits dirty. A mutator throws `EditAborted` to bail out after reporting its own error; pass `errorLabel` for the applyEdit-rejected case and `onSuccess` for follow-up work such as `selectorsService.scheduleRegenerate()`. `applyModelEdit()` routes `logical-models/*.yml` changes through the **same** `WorkspaceEdit` (`modelFiles: { save: [{ model, fromName? }], delete }`) so a model edit and its domain change are atomic and one undo step — never `fs.writeFileSync` a model file from a handler (`addExistingModel` seeds a new library file the same way, so a rejected edit leaves no orphan yml). `fromName` names the file whose existing YAML document supplies comments / key order / unknown keys: a rename passes the OLD name so hand-written content is carried to the new file instead of being regenerated. Every file the pipeline writes is recorded in `ownWrites` **after** the bytes land (the tracker stats the file), so the watchers skip our own saves; the refreshes they used to drive are issued directly instead — `sendDomainData` for the editing panel, `refreshDomainsReferencingModel(name, exceptPanelKey)` for other open panels, and the `onDidWriteDomain` event for the tree / model library views. An undo/redo flushes only the yml documents this provider itself wrote for that domain (`editedModelPaths`) — a model file the user is hand-editing in another tab is never force-saved. Payloads are validated at the message boundary by `src/providers/payloadValidation.ts` (model names via the shared `MODEL_NAME_PATTERN` in `src/types/naming.ts`, column lists incl. duplicates, `keyType`, `cardinality`, `modelRole`, finite positions); `LogicalModelService.modelPath` refuses names that escape `logical-models/`. The message listener is wrapped in `withMessageErrorBoundary()` so a throwing handler posts an `error` instead of becoming an unhandled rejection. Refresh paths (watchers, external edits, stage switches) never write — only the initial `ready` load persists auto-computed positions.

### Activation (`src/extension.ts`)

- **Project detection** — `resolveDbtProjectRoot()` honours `erdStudio.projectPath`, then workspace folder roots, then a depth-3 search for `dbt_project.yml` (skipping `node_modules`, `dbt_packages`, `.git`, `target`, venvs). With no project found, `registerFallbackCommands()` registers every contributed command (plus aliases) with a "no dbt project" warning and a stub custom editor, so nothing reports "command not found".
- **`erdStudio.reportBug`** (titled **Send Feedback**) is registered before any early return so it always works. `ReportTrackingService` and `MyReportsTreeProvider` are constructed immediately after `editorProviderForFeedback = editorProvider` — before `refreshContextKeys()` is defined and synchronously called — and the provider gets the tracker via `setReportTracking()` rather than a sixth constructor argument.
- **Update recovery** — if the extension version changed since last activation and a canvas is open, the host offers a save-all + window reload (`recoveryService`); the webview also detects orphaning and sends `requestReload`. The custom editor is registered with `retainContextWhenHidden`.
- **No unprompted writes** — activation may rename a legacy `erd-studio/` dir to `.erd-studio/` (with a notice) but otherwise writes nothing: `SelectorsService.regenerate()` returns `noop` when there is nothing to write, harness updates and v4→v5 migration always prompt.
- **Context keys** `erdStudio.hasSemanticDir` / `erdStudio.hasLogicalModelsDir` are refreshed by `refreshContextKeys()` after every relevant watcher event and command. `erdStudio.hasTrackedReports` (which gates the **My Reports** view) is deliberately **not** one of them — `ReportTrackingService` sets it itself, so activation never has to reference the service from `refreshContextKeys`.
- **Settings changes** to `semanticDir` / `projectPath` (either prefix) prompt for a window reload.

### Watchers (`src/watchers/FileWatcherService.ts`)

Own writes are recorded in `ownWrites` (`src/services/ownWriteTracker.ts`, path + mtime/size, 5 s TTL) by `SemanticEditorProvider` (the editor write path — domain file, model yml saves, creates and deletes), `LogicalModelService`, `LayerService` and the `deleteDomain` command, and consumed in the callbacks that watch files the extension itself writes (domain `.json` changes and deletes, `layers.json`, `logical-models/*.yml`) so an extension save never triggers a second identical refresh. The manifest and `dbt_project.yml` callbacks have nothing to consume — the extension never writes those. `renameDomain` (`extension.ts`) is the one gap: its create+delete `WorkspaceEdit` records neither path, so the old file's delete is seen as external. `classifySemanticPath()` ensures only `{layer}/{domain}.json` fires `onSemanticFileDeleted` (coalesced to one `{ uris }` event per burst); `layers.json` has its own `onLayerConfigChanged`. `LayerService.loadConfig()` is mtime-validated and refuses to overwrite an unreadable/invalid `layers.json` (`getLoadError()`).

## Send Feedback

`erdStudio.reportBug` — the command id is kept for existing keybindings; its title is **Send Feedback** — opens a **prefilled GitHub issue form** (`.github/ISSUE_TEMPLATE/bug_report.yml` or `feature_request.yml`, repo `liam-machine/erd-studio`) via `vscode.env.openExternal`. Nothing is ever filed from the extension: the user reviews the form and presses Submit on github.com as themselves, so no write token is needed. It is reachable from the palette, the sidebar title bar, the canvas toolbar and the canvas error screen.

- **With a canvas** the host posts `openFeedback` (optional `{kind, title, description}` prefill) and the webview's `FeedbackDialog` takes over. It posts six messages, all on the physical-stage allowlist: `requestFeedbackContext` (on open) → `feedbackContext`, whose `capabilities.aiNeedsPriming` tells the dialog to render the first-run button instead of auto-running; `analyzeFeedback` (debounced, or `trigger: 'user'` from that button) → `feedbackAnalysis`; `submitFeedback` → `feedbackSubmitted`; plus `copyFeedbackReport`, `requestGithubSignIn` and `openFeedbackLink`. **Without a canvas**, a QuickPick (`Report a bug` / `Request a feature`) then two input boxes gather the kind, title and description.
- **Kind.** `FeedbackKind = 'bug' | 'feature'` drives the issue template, the field ids (`steps` vs `rationale`) and every label — all of the frozen copy is `FEEDBACK_COPY` in `src/types/feedback.ts`, which both ends import rather than re-declaring. That file is compiled by both tsconfigs **and** the mcp-server job, so it must stay free of `vscode` and of DOM types; the pure helpers the webview needs (`readinessScore`, `footerRoute`, `compareVersions`, `duplicateModeFor`, `applyRegressionPrefix` / `stripRegressionPrefix`) live there for exactly that reason. The kind switch (`Not right? Make it a …`) renders in the dialog header whenever the analysis panel is not showing its own copy — on a host where no tier resolves (no language model, no endpoint, no hosted service) that header link is the **only** route to the feature-request template, so it must never be moved back inside `AnalysisPanel`.
- **Images — one route, the canvas capture.** GitHub has no API for attaching an image to a prefilled issue form, so an image can only reach the issue through the user's clipboard or their own paste/drop on the GitHub page. The extension does the canvas capture better than a user can by hand (right crop, one click, already on the clipboard) and a file they already have on disk it cannot, so there is **no picker, no drop zone and no paste-to-attach** — the Images section carries a standing note saying other images are added on the GitHub page. Do not add those routes back. The capture is `webview/lib/screenshot.ts` (`html-to-image`) → `canvasAttachment()` in `webview/lib/feedbackAttachments.ts`, which applies `MAX_ATTACHMENT_BYTES` (10 MB) before the host validator sees it. `MAX_ATTACHMENTS` is **1**, and the payload stays list-shaped (`attachments`, 0 or 1 entries) so the host contract and `validateFeedbackAttachments` do not change shape. `copyImageToClipboard` sets `onClipboard`, and the host branches both the issue-form `screenshot` body and its notification on that flag; `feedbackService.saveAttachments()` writes the PNG to `<globalStorage>/feedback/<stamp>/` with a **Reveal Folder** action, which is the fallback that makes a refused clipboard recoverable — keep it.
- **Diagnostics** are collected by `collectDiagnostics()` and shipped to the dialog as `buildDiagnosticsView()` — chips plus the verbatim `formatDiagnostics()` text — so the webview never reconstructs them. `composeFeedbackFields()` builds the issue-form fields and `buildIssueUrl()` truncates the verbose ones to stay under `MAX_ISSUE_URL_LENGTH`; `composeMarkdownReport()` backs the **Copy report** button, which needs no network, no GitHub and no model.
- **AI assist (`src/services/feedbackAnalysisService.ts`)** — one optional call, behind `erdStudio.feedback.aiAssist` (**on** by default), returning kind + confidence, a suggested title, extracted context, gap prose and ranked duplicates. `resolveAnalysisTier()` picks between four tiers, in the order that lets the user's own choices win: **(1)** VS Code's language model, feature-detected at runtime through the `getLanguageModelApi()` shim (`engines.vscode` stays `^1.85.0` and `@types/vscode` stays 1.85.0 — never write `vscode.lm.` directly), selected with **no** selector so any vendor is accepted; **(2)** an OpenAI-compatible endpoint (`feedback.endpoint` + `feedback.model`, key in `context.secrets` via `erdStudio.setFeedbackApiKey`); **(3)** the author's hosted proxy at the build-time constant `HOSTED_ANALYSIS_ENDPOINT` (see `proxy/`), gated by `feedback.hostedFallback`; **(4)** none, in which case the AI panel does not render and the dialog is exactly the pre-AI dialog. Tiers 2 and 3 are the **same** request through `postChatCompletion()` — the hosted one simply carries no `Authorization` header, because the proxy holds the key; do not write a second client. **Diagnostics are never sent to the model** — `buildAnalysisPrompt()` takes no `Diagnostics` parameter by construction, and a unit test asserts the prompt contains none of it. **Consent is split by who chose the destination.** Tier 1 shows **no modal of ours**: VS Code's language model access dialog is the real gate and it already names the extension. What tier 1 does instead is honour the "not out of the blue" guidance — an unprimed machine refuses a debounced request and only runs one carrying `userInitiated` (the panel's **Analyse this for me** button), then sets `FEEDBACK_LM_PRIMED_KEY` in `globalState` on the **first successful** request so the debounce runs unattended for ever after. A failure must not set it, or a dismissed dialog would kill the feature silently. Tiers 2 and 3 always ask, once **per destination** — the accepted host is what is stored under `FEEDBACK_AI_CONSENT_KEY`, not a boolean, so re-pointing `feedback.endpoint` asks again instead of inheriting a yes about somewhere else; the hosted prompt additionally names **both** the author's relay and `HOSTED_ANALYSIS_PROVIDER` — the third party the relay forwards to under the author's key — and says how to turn it off, because the user did not pick that destination; its stored consent is keyed `"<host>|<provider>"` so a change of processor re-asks. `safeBaseUrl()` (behind both `endpointBaseUrl()` and the hosted target) accepts only `https:`, plus `http:` on loopback for a local model server or a `wrangler dev`; anything else resolves to `''` and the tier degrades to `none`. **`HOSTED_ANALYSIS_ENDPOINT` and `HOSTED_ANALYSIS_PROVIDER` both ship empty**, which means the hosted tier does not exist in a published build and behaviour is identical to the three-tier one — `resolveAnalysisTier()` requires **both**, so an endpoint shipped without a named recipient resolves to `none` rather than sending text under a disclosure that omits who receives it. Fill them in the same commit; `setHostedAnalysisTargetForTests()` is the only other way to reach the tier. Every failure degrades to `{ analysis: null }`; a model outage must never block a report. Duplicate candidates are **hydrated** from the fetched issue list — `parseAnalysisResponse()` takes only `{ number, match, why }` from the model, so a hallucinated `state_reason` can never tell someone to update for a bug that is still open.
- **Duplicate takeover.** `fixed` mode is three-valued (`FixState` in `DuplicateTakeover.tsx`): `outdated`, `current`, or — the ordinary case, because GitHub only records a fix version when the issue carries a milestone or a `shipped-in:` label — `unknown`. Only `current` may claim a regression: it is the one state where the user demonstrably has the fix, and it alone sets `regressionOf` and the `Regression: ` title prefix. `unknown` asserts nothing and offers **File it anyway**. A "file anyway" / "regression" choice is bound to the duplicate it was made against (`choiceFor`), so a later analysis cannot carry it onto an unrelated issue.
- **Nothing auto-sends text the user did not write.** The canvas error screen opens the dialog with the host's raw exception as the description, and that string carries absolute domain file paths and dbt model names. `FeedbackDialog` keeps the opening description in `prefilledDescriptionRef` and suppresses the debounce while the field still equals it, offering the same **Analyse this for me** button instead; one keystroke makes the text the user's and the debounce resumes. Do not "fix" this by sanitising the error string — the host builds those messages in several validators and any regex would rot. `runAnalysis` additionally refuses a **debounced** repeat of the request already in flight (same text *and* same request id), which is what stops the primer's hand-over from firing a second identical model call; a `trigger: 'user'` click always goes through so a failed first run can be retried.
- **Readiness** is scored locally by `readinessScore()` (`READINESS_MAX === 100`); the model supplies only the `why` prose for unmet checks, so attaching an image moves the bar with no round trip. It is advice — submitting at 20% is allowed.
- **Tracking (`src/services/reportTrackingService.ts`, `src/providers/MyReportsTreeProvider.ts`)** — the handle comes from a **silent** `getSession('github', ['read:user'], { silent: true })`; with no session the **My Reports** view simply does not appear and nobody is prompted. Because the issue is filed in the user's browser, `recordPending()` records the moment the form opened and a later unauthenticated `GET /search/issues` reconciles by normalised title. The service owns its own `erdStudio.hasTrackedReports` context key. `shippedIn` comes from `milestone.title` or a `shipped-in:<v>` label — never a guess — and one notification fires per newly shipped report.
- Pure helpers (`formatDiagnostics`, `buildIssueUrl`, `composeFeedbackFields`, `composeMarkdownReport`, `ErrorLog`, `trackedReportLabel`, `reconcileReports`, `parseAnalysisResponse`) have no VS Code dependency and are unit-tested.

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
