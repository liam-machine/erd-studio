# Draft-first onboarding

> Spec for the Draft-first start (chosen by Liam, 2026-11-04). Read before touching the draft services (`src/services/draft*.ts`), the preview (`src/providers/DraftPreviewPanel.ts`, `webview-draft/`), the start suggestion, the empty Diagrams view's trigger, or any import's dry run. The shared contract is `src/types/draft.ts`; this file says what it is for and who builds what. Once shipped, the user-facing rules move into `docs/dev/onboarding-and-cli.md` and this file keeps the design and the package plan.

## 1. The idea

Many installs never come back. The first minute asks too much (a popup, then a picker, a layer, a name, a ten-line modal) before the user sees anything, and the same offer is repeated on four surfaces with different labels.

Draft-first turns that round: **the first time someone deliberately turns to ERD Studio in a folder with no diagram, it shows a draft of their logical model, built from what it found, as a read-only diagram in an editor tab, and writes nothing until they press Keep.** Nothing found: the draft is an example. Every capability stays; it moves behind the draft (Change options…, More ways to start, the switcher, the details drawer).

Rules that hold everywhere:

1. **Nothing is written before an explicit Keep**, and nothing on activation (no `.erd-studio/`, no `layers.json`, no workspace file). Building a draft reads files only, through the same bounded reads the imports use today.
2. **One writer per kind.** Keep runs the existing write step of Import DBML (`writeNewSubjectArea` via `importDbml`), Draw from dbt (`writeNewSubjectArea` via `drawFromDbt`) or Open an Example Project (`writeFilesWithRollback`). No draft code writes a file.
3. **One activation-time prompt per window** (`SessionPromptGate`). The automatic draft is a prompt too: it claims the gate.
4. **Nothing about the user's files leaves the machine.** Telemetry gets fixed keys only (append-only, §11).
5. **The page is a webview with a nonce-only CSP**, no inline style or handler, every command and URL fixed on the host, every message validated (`parseDraftToHost`).
6. **VS Code 1.85 APIs only**; no `vscode` in the pure services; the VSIX stays at or under 60 files (the new bundle adds `dist/draft.js` and `dist/draft.css`: 42 → 44).
7. Wording: DBML is "an open format"; "diagram" in prose; no dbt word or control in a folder without `dbt_project.yml`; every command named exists as written.

## 2. The draft preview

An editor tab (`WebviewPanel`, view type `erdStudio.draftPreview`, title `Draft: <name>` or `Example: <title>`, singleton, no serializer: it closes on reload). Top to bottom:

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ Draft from 4 SQL files (PostgreSQL) · 24 tables, 31 relationships · not saved        │
│ Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml).     │
│ Change options… · 2 notes, 3 left out: Show details                                  │
│                         [Keep as Diagram]  [More ways to start ▾]  [Discard]        │
├──────────────┬─────────────────────────────────────────────────────────────────────┤
│ Schemas  «   │                                                                       │
│ All tables 24│         ErdCanvas (viewer): the diagram exactly as the canvas        │
│ sales     14 │         will draw it after Keep                                       │
│ finance   10 │                                                                       │
└──────────────┴─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Banner strings (built by the pure services, P1)

Headline, `<what> · <counts> · not saved`:

| Source | Headline |
|---|---|
| `sqlDdl` | `Draft from 4 SQL files (PostgreSQL) · 24 tables, 31 relationships · not saved` (the import's own `sqlOriginPhrase`) |
| `semanticModel` | `Draft from the semantic model Sales · 12 tables, 11 relationships · not saved` (the import's own `origin.from`) |
| `dbml` | `Draft from sales.dbml · 9 tables, 8 relationships · not saved` |
| `dbt` | `Draft from your dbt models in marts/finance · 12 tables, 9 relationships · not saved` |
| `example` | `Example: a coffee-shop star schema · 6 tables, 6 relationships · not saved` |
| `exampleProject` | `Example: <project title> · 31 tables, 30 relationships · not saved` |

Counts: `1 table`, `no relationships`; thousands separated (`1,204 tables`).

Detail line:

- Keep possible: `Keep saves it as <name> in the <Layer> layer (<diagramFile>).` Plus, when tables are reused or changed: ` 3 tables are already in your Table Library and are used as they are.` / ` 2 tables in your Table Library gain a relationship.`
- dbt over the cap: ` Drew the 15 best-connected of 40 models; add the rest from the canvas.`
- Example with no folder open: `Open a folder to keep a copy of it.`
- Example project: `Save This Example… copies it to a folder of its own and opens it there.`

Second line, each part only when it applies: `Change options…` (a link), then `<n> notes, <m> left out: Show details` (`Show details` opens the drawer). A redraw adds the notice line `Your ERD Studio files changed, so the draft was redrawn. Check it and keep it again.`

Buttons (Title Case, one primary):

| Draft | Primary | Others |
|---|---|---|
| A find (`sqlDdl`, `semanticModel`, `dbml`) | **Keep as Diagram** | **More ways to start ▾** (New Diagram… · Import… · Bring In Your Data Model… · Open an Example…), **Discard** |
| `dbt` | **Keep as Diagram** | **More ways to start ▾** (New Diagram… · Import… · Open an Example…), **Discard** |
| `example`, folder open | **New Diagram…** | **Bring In Your Data Model…**, `Keep This Example` (a quiet link-style button), **More ways to start ▾** (Import…), **Discard** |
| `example`, no folder | **Open Folder…** | **Discard** |
| `exampleProject` | **Save This Example…** | **New Diagram…** and **Bring In Your Data Model…** (folder open) or **Open Folder…** (no folder), **Discard** |

`DraftOtherStart` → command (host table, P3; never from the page): `blank` → `erdStudio.createDomain`; `import` → `erdStudio.importModel`; `guide` → `erdStudio.showImportGuide` `{ from: 'draft' }`; `example` → the example draft (§9); `openFolder` → `vscode.openFolder` (VS Code's picker). Choosing one closes the draft first.

**Discard** closes the tab, writes nothing. Closing the tab is the same (counted apart).

### 2.2 The switcher (`DraftScopes`)

A labelled `<select>` in the banner, only when there is a choice:

- **dbt** (`Folder`): the models folders (`listDraftScopes` folder scopes), ranked by `folderRank` (marts / gold first, staging last), then by model count, at most 12, each `marts/finance` · `12 models`. The draft starts on the first. Keep names the diagram after the folder (`suggestSubjectAreaName`). Hand-picking models, or a connected cluster, is **Change options…** (Draw from dbt's own picker).
- **Several semantic models** (`Model`): each model the folder holds, by path, at most 12; the draft starts on the first.
- **Examples** (`Example`): `Coffee shop` (6 tables) then the eight `docs/examples` projects in `docs/examples/README.md`'s order.

Changing it answers `scope`; the page shows **Drawing…** until the flow asks with the next draft. A scope that draws nothing comes back as the same draft with a notice: the flow awaits its re-entry (`afterScope`, `draftModel.ts`), and when the preview still shows its own draft (`DraftPreview.showing()`) it asks that draft again with `DRAFT_SCOPE_EMPTY_NOTICE`. A switcher re-entry is never quiet: the user chose it, so a reason it stops is shown.

### 2.3 Large drafts and the schema panel

`DRAFT_LARGE_TABLES = 60`. At or above it the schema panel starts open; with more than one schema the canvas first shows only the biggest schema's tables (`focusSchema`) and the panel says `Showing sales: 80 of 257 tables`. The panel lists **All tables (257)** then each schema with its count, biggest first; clicking one redraws the canvas with that schema's tables and the relationships between them (page-local, never posted: P2's `filterDisplayToSchema`). Below the cap the panel is collapsed (`«` / `»` toggles it). The panel and the drawer are views only: **Keep keeps every table**. Bringing in fewer is Change options… (SQL's file pick, Draw from dbt's picker).

### 2.4 The details drawer

`Show details` opens a drawer on the right with what Review All… showed, as data (`DraftDetailSection[]`, rendered as text, never HTML): every table by schema with its columns and keys, every relationship with its cardinality, the Table Library's reused and changed tables, renames, everything left out and why, every note. Built from `buildImportReview(plan, …)`'s sections for an import, from the `DbtDraft` (its `skipped`, `truncated`) for dbt.

### 2.5 Layout

`autoLayout` (no table has a stored position, `isFreshLayout`'s rule): the page runs the canvas's own ELK layout (`webview/lib/elkLayout` `runElkLayout`, with the options the canvas's first-open layout uses) before drawing, showing `Laying out 257 tables…`; the canvas runs the same layout when it first opens the kept diagram, so the preview is what Keep makes. A file with `erd_layout` positions is drawn as positioned. ELK failing draws `display`'s fallback placement (`computeMissingPositions`) and posts `layoutFailed`.

## 3. Triggers and the prompt gate

### 3.1 What opens a draft

| Trigger (`DraftTrigger`) | When | Gate |
|---|---|---|
| `sidebar` — **the only automatic one** | The empty Diagrams view is drawn in this window (the tree's `onLoadingChange(false)`: the ERD Studio icon), after the tracker's bounded look, when `autoDraftDue` holds (§3.2) | Claims kind `draft`, only once activation's own prompt is decided (`activationPromptsSettled`); never when another prompt showed this window |
| `prompt` | The start suggestion's **Show Me** | Already holds the gate (`startSuggestion`) |
| `start` | A start surface's primary import or Draw from dbt (walkthrough, empty Diagrams view, start quick pick) | Explicit: never checks the gate; claims `draft` if free, so nothing pops over it |
| `palette` | Import DBML… / Import SQL DDL… / Import Semantic Model… run step by step | Explicit, as above |
| `changeOptions` | The step-by-step flow a draft's Change options… ran | Explicit |
| `example` | **Open an Example…**, a draft's **Open an Example…** | Explicit |

The `sidebar` draft opens with `preserveFocus` (the Diagrams view keeps the focus) and a progress bar on the Diagrams view (`withProgress({ location: { viewId } })`) while it builds; it is **quiet**: any question or error the quick path would raise before the draft (several dialects, no CREATE TABLE after all, no layer, an unreadable file) ends it silently (logged, `draftUnavailable`), leaving the sidebar's starts; the explicit starts keep today's questions and messages.

### 3.2 `autoDraftDue` (pure, P1)

An automatic draft is due when all hold: `erdStudio.startSuggestions` is on; the folder's start suggestions are not off (Don't Ask Again / Turn Off); the folder has no diagram **and no table**; no canvas is open; and either

- the suggestion is a find (`drawFromDbt`, `importSemanticModel`, `importSqlDdl`, `importDbmlFile`) and this folder has not had an automatic draft (`draftShown`) nor answered the suggestion (`answered`) → **find**; or
- the suggestion is `blank` and this machine has not had the automatic example (`erdStudio.exampleDraftShown`, globalState) → **example**.

`convert` is never drafted (Convert has its own review panel). The flags are written **before** the draft shows (a crash cannot make it repeat).

### 3.3 The start suggestion (the one popup)

Still the window's activation prompt (`startSuggestion`, after `diagramsNudge`), once per folder (Simplify: it was three times), shown only after the bounded look. New text and buttons:

- `ERD Studio found CREATE TABLE scripts in this folder (24 tables). Show them as a diagram? Nothing is saved until you keep it.` (no count: `…in this folder. Show them as a diagram? …`)
- `ERD Studio found a Power BI or Fabric semantic model in this folder. Show it as a diagram? Nothing is saved until you keep it.`
- `ERD Studio found a DBML file in this folder. Show it as a diagram? Nothing is saved until you keep it.`
- `ERD Studio found a dbt project in this folder. Show its models as a diagram? Nothing is saved until you keep it.` (opened from one of its subfolders, such as `models/`: `…in a folder above this one…`, `dbtProjectAboveOpenFolders`)
- Convert unchanged: `This project is from an older ERD Studio. Convert it once to DBML, an open format: your tables stay as they are.` with **Convert to DBML…**.

Buttons: **Show Me** (Convert: **Convert to DBML…**) and **Don't Ask Again for This Folder**. **More Options…** is gone (the draft's More ways to start replaces it). Show Me answers it for good and opens the draft (`prompt`); Don't Ask Again turns suggestions off for the folder (same message as today) and the folder then gets **no** automatic draft and **no** walkthrough.

The **nothing-found notification** (`runNothingFoundPrompt`) is removed: a folder with nothing found gets the example draft on the ERD Studio icon, once per machine, and otherwise only the sidebar.

### 3.4 The rest of the prompt drip

- **The walkthrough auto-opens only in an empty window** (no folder). In a folder the draft takes its place: a find's draft, or the example draft. It is never opened in a folder whose start was offered or declined. It stays reachable (Help & Feedback, VS Code's Welcome page, the palette). This includes VS Code's own open-on-install: the walkthrough's `when` (`workspaceFolderCount == 0 || erdStudio.activated`) keeps a Marketplace install in a folder from opening it beside the start suggestion; the first-60-seconds stories hold every workspace to one interruption.
- **Keep marks the folder as started**: `DIAGRAMS_NUDGE_SHOWN_KEY` is set (no "This project has 1 ERD Studio diagram" about the diagram just made) and the suggestion is `answered`.
- **An example project's new window** (`takePendingExample`) claims the gate (kind `exampleOpen`), so the AI helper offer never covers its first canvas.
- A draft open in the window holds the gate: nothing else pops over it.

`SessionPromptKind` gains `draft` and `exampleOpen` and loses `nothingFound`; `ACTIVATION_PROMPT_PRIORITY` loses nothing but `walkthrough` is offered only with no folder open (`walkthroughAutoOpens`, P1).

## 4. Flows by workspace

| Workspace | What the user meets | Keep writes |
|---|---|---|
| **No folder** | First run: the walkthrough (Open Folder, Open an Example…). The Diagrams view: **Open Folder**, `Open an example` link. Open an Example… → the coffee-shop example draft, primary **Open Folder…**; the switcher's projects offer **Save This Example…** | An example project, in a folder of its own (new window) |
| **Empty folder** (plain, nothing found) | ERD Studio icon → the example draft once per machine (**New Diagram…**, **Bring In Your Data Model…**, `Keep This Example`). Later: the sidebar's **New Diagram** and links | `Keep This Example`: the coffee-shop diagram into this folder (`importDbml` source `example`); `.erd-studio/` and `layers.json` only then |
| **SQL scripts** | Activation: the popup (Show Me). Or the icon: the draft directly. The draft of every CREATE TABLE script (the quick path's files and dialect) | `importDbml` source `sql` (quick answers: layer, name) |
| **Power BI / Fabric** | As SQL; several models: the first, with the `Model` switcher | `importDbml` source `semanticModel` |
| **A DBML file** | As SQL (`findDefaultFile`) | `importDbml` source `file` |
| **dbt project** | The popup (Show Me) or the icon: the draft of the top-ranked models folder, the `Folder` switcher | `drawFromDbt`'s write step, named after the folder |
| **Pre-2.0 project** | Unchanged: the Convert offer (popup, sidebar row, canvas). No draft | — |
| **Existing diagrams** | Unchanged: the diagrams nudge opens one. No automatic draft; a palette import ends in the draft preview (its dry run) | The import's writer |
| **Query-only SQL repo** | Detection (§13.2) finds no DDL there, so nothing is found: no popup ever; the icon shows the example draft once per machine | as empty folder |

**Open Folder… from a draft** (the no-folder example's primary, and the guide's *Open your folder* step) reloads the window into the chosen folder. Before VS Code's Open Folder runs, the host writes `DRAFT_AFTER_OPEN_FOLDER_KEY` in globalState, `{ at, guide }`, and waits for the write (`beforeOpenFolder` in `draftWiring.ts`). The window that opens takes the mark once, while it is fresh (`draftAfterOpenFolderDue`, 10 minutes). If the folder has no diagram, that folder's draft shows at once (`draftAfterOpenFolderShows`: the find, else the example), in place of the start suggestion, which is not shown: the user already asked to see what is there. The draft holds the window's prompt, and the folder's suggestion is marked `draftShown`. With `guide`, phase A carries on on that draft as the same run (`OnboardingGuide.resumeDraft`; nothing counted again; `resumed` leaves out More ways to start). If the folder has diagrams and the guide was running, the newest diagram opens and phase B runs on it. Counted `draftAfterOpenFolder`.

## 5. Keep: the existing writers

### 5.1 Imports (`importDbml`)

The three quick imports, the step-by-step imports and the coffee-shop example all end in `runImportDbml`, which plans (`planDbmlImport`), checks refusals and unsaved files, shows the dry run, then writes (`writeNewSubjectArea`). The seam is the dry run:

- `ImportDbmlDeps` gains `draft?: ImportDraftOptions` — `{ preview: DraftPreview; trigger: DraftTrigger; quiet?: boolean; scopes?: DraftScopes; onScope?(scopeId: string): unknown; generation?(): number }`.
- With `draft`, step 5 builds the `Draft` (`draftFromImportPlan`, P1) from the plan it just made and **awaits `preview.ask(draft)` in place of `dryRun`**. Without it (tests' fakes, a host with no preview) the modal stays, as the fallback.
- `keep` → step 6 unchanged (`writeNewSubjectArea`, the same error handling), then `settle({ kept: true })` and the diagram opens; a write that fails settles `{ kept: false }` after its own message, then asks the SAME `Draft` object again, so the page's buttons keep answering (the panel replays a choice made in between, and a same-object ask redraws nothing). From the Keep on, the automatic draft's quiet UI is dropped: what follows the Keep (a write failure, a redraw's name box, Try Again) is said.
- **Staleness.** The plan is the one shown; if the semantic dir changed since it was made (`generation()`, bumped by the existing watchers for writes that are not ERD Studio's own, and by `ownWrites.onRecorded` for ERD Studio's own writes under the semantic dir, such as a canvas edit in this window while the draft is open), Keep settles `{ kept: false }`, re-enters `importDbml` with the same file, layer and name (`ImportDbmlResume.redraw: fingerprint`) and plans again: the same `importPlanFingerprint` → it writes at once; another → it asks again with the notice line.
- `changeOptions` → the existing `deps.changeOptions(chosen)` (quick paths only; the step-by-step flow has no link). The step-by-step flow it runs ends in a draft again (`trigger: 'changeOptions'`).
- `scope` → `draft.onScope(scopeId)` (the semantic model or example caller re-enters with that choice and the same preview).
- `discard` / `closed` → the source's `*Cancelled` key plus `draftDiscarded` / `draftClosed`. `otherStart` → the mapped command. `superseded` → stop, counting nothing.
- `quiet` → no question is asked and no message shown before the draft (a wrapper UI whose pickers resolve undefined and whose messages go to the log), and its early ends count `draftUnavailable` only.

The quick paths (`quickImportSqlDdl`, `quickImportSemanticModel`, `quickImportDbml`) already answer the file, dialect, layer and name; they pass `draft` through. The name question on a quick path stays only when the suggestion is not a valid name.

### 5.2 dbt (`drawFromDbt`)

- `DrawFromDbtDeps` gains `draft?: DbtDraftOptions` — `{ preview; trigger; quiet?; generation? }`; `DrawFromDbtResume` gains `scopeId?`.
- With `draft` and no `resume.pick`: the scope is the switcher's default (`dbtDraftScopes`, P1), the layer `scope.suggestedLayer` when creatable, else `defaultDiagramLayer`, the name `suggestSubjectAreaName` made free — no picker, no layer pick, no name box (asked only when the name is not valid). With `trigger: 'changeOptions'` the picker, layer pick and name box run as today.
- After the routing and unsaved-file checks (where it now writes), it builds the `Draft` (`draftFromDbt`, P1) and awaits `ask`. `keep` → the existing `writeNewSubjectArea` call and notice; `scope` → re-enter with `{ scopeId }` and the same preview; staleness as §5.1 (`dbtDraftFingerprint`).

### 5.3 Example projects (`openExampleProject`)

`Save This Example…` → `openExampleProject(deps, { id })`: the folder dialog onward, unchanged (`writeFilesWithRollback` into `<parent>/<id>/`, the pending-open record, `vscode.openFolder`).

## 6. Change options…

The quick path's step-by-step flow, preselected, exactly as today's dry-run button: SQL's file pick (every script found, picked; `Other files or a folder…`), then the dialect, layer and name; a semantic model or DBML file keeps its source and asks the layer and name; dbt runs its picker (folder, cluster or hand-picked models), the layer and the name. It ends in a draft (`changeOptions` trigger), not a modal.

## 7. dbt specifics

`dbtDraftScopes(listDraftScopes(source))` → the folder scopes with at least one drawable model, ranked as §2.2; the default is the first. The draft caps at `DRAFT_MODEL_LIMIT` (15) best-connected models (`buildDbtDraft`), `summary.available` holds the folder's count. Reading dbt (`loadDbt`) shows the existing progress notification on an explicit start and the Diagrams view's progress bar on the automatic one. No dbt models with columns: explicit → `NO_DBT_MODELS_MESSAGE` as today; automatic → nothing (`draftUnavailable`).

## 8. Large and slow drafts

Building is bounded by what the quick paths already bound (the start look's shared listing, `listImportFiles`: 16 folders deep, at most 5,000 names; at most 500 `.sql` files opened; 20 MB of SQL once a dump's data is stripped, `withoutSqlData`; no file over `MAX_SQL_FILE_BYTES`, 200 MB; the semantic model's limits). The automatic and quick drafts take what the look offers: the same listing and the same test (`isSqlScriptTaken`), so never a CTAS, a dbt macro, a Databricks notebook or Oracle DDL (a file picked by hand in Change options… is still read). The page lays out in the webview, off the host. Over `DRAFT_LARGE_TABLES` see §2.3. The details drawer renders sections lazily (first 200 items per section, `Show all`).

## 9. Examples: one command

**Open an Example…** (`erdStudio.openExampleProject`, retitled; pre-registered, works in an empty window) opens the example draft on the coffee shop, with the `Example` switcher over the eight projects. In a folder, the coffee shop is drafted by `openExampleDiagram`'s own path (Import DBML with the example supplied, `quick`, `draft`), so `Keep This Example` writes it into the folder; with no folder it is planned in memory against an empty library and the default layers (`exampleDbmlDraft`, `keep: none`). A project is read from the bundled files (`__ERD_EXAMPLES__`, `exampleFiles(id)`) through core's `loadDisplaySubjectArea` with an in-memory `readFile` and `dbmlStorageReader` (`draftFromExampleProject`). `erdStudio.openExampleDiagram` stays registered (the setup skill names it), hidden from the palette, and opens the same draft; `erdStudio.trySampleProject` stays on the dbt Welcome page only. The start surfaces' "Open an example" entries all run the one command.

## 10. What is removed or merged, and where each capability lives

| Today | After |
|---|---|
| Quick import confirm (the ten-line modal) | The draft preview's banner. The modal remains only as the no-preview fallback |
| **Review All…** and the Review Import page (`ImportReviewPanel`, `isImportReviewToHost`, `buildImportReviewHtml`) | The details drawer and schema panel. `ImportReviewPanel.ts` deleted; `importReview.ts` keeps `buildImportReview`, `describeImportTable`, `relationshipLines` (P1 uses them) |
| Start suggestion's **Create Diagram** / **More Options…** | **Show Me** / the draft's More ways to start |
| Nothing-found notification | The example draft on the icon (once per machine) |
| Welcome tab's start card, Convert card and "Open your diagrams" card | Gone: the Welcome tab is the tour, the AI helper section and a **Show Me Around** section (the interactive guide), none on the start path. The no-folder page keeps **Open Folder…** |
| Open Example Diagram / Open an Example Project… / the example quick pick | **Open an Example…** and its switcher |
| Walkthrough auto-open on a folder's first run | The draft. Walkthrough auto-opens only with no folder |
| Name and layer questions on the quick paths | Answered (asked only when the default is not valid); Change options… asks them |

Capabilities and where they are now: pick SQL files / dialect / layer / name → Change options…; choose among semantic models → switcher; choose dbt models → switcher (folders) or Change options… (picker, clusters, hand-picked); see everything an import brings in or leaves out → Show details; read a big import → schema panel; start blank / Import… / the import guide / an example → More ways to start; turn suggestions off → Don't Ask Again for This Folder and the two palette commands (unchanged); Convert → unchanged; Try the Sample Project → dbt Welcome page.

## 11. Telemetry (append-only)

New `FEATURES` keys, mirrored in `telemetry/src/index.js`, `telemetry.json`'s comment and `telemetry/README.md` (Onboarding funnel: a **Draft** row, and `chose_start` counts `draftKept`); old keys stay listed though no longer sent (`suggestPromptMore`, `suggestPromptNothing*`, `importReviewOpened`):

| Key | Meaning |
|---|---|
| `draftShown` | A draft preview was shown (any source, any trigger) |
| `draftShownAuto` | …opened by the ERD Studio icon alone (`sidebar`) |
| `draftExampleShown` | …of an example (`example` or `exampleProject`) |
| `draftSourceSqlDdl`, `draftSourceSemanticModel`, `draftSourceDbml`, `draftSourceDbt` | Which kind of find it showed (never a name, path or count) |
| `draftKept` | Keep wrote it (beside the source's own `importSqlDdl` / `drawFromDbt` / `exampleDiagram` / `exampleOpened`) |
| `draftChangeOptions` | Change options… |
| `draftDiscarded` | Discard (a user cancel: a feature) |
| `draftClosed` | The tab was closed without a choice |
| `draftOtherStart` | One of More ways to start (the start's own key counts which) |
| `draftScopeChanged` | The switcher was used |
| `draftDetailsOpened` | The schema panel or details drawer was opened |
| `draftRefreshed` | Keep found the files changed and redrew |
| `draftUnavailable` | An automatic draft could not be built and was dropped quietly |
| `suggestPromptShowMe` | The popup's Show Me (`suggestPromptAccepted` stays Convert's) |
| `importGuideFromDraft` | The import guide opened from a draft |

Error codes (`TelemetryErrorCode`): `draftBuildFailed` (building a draft threw: ours), `draftLayoutFailed` (the page's ELK failed). Detection's per-window activation and dbt-tooling flags are §13.2's.

## 12. Security and limits

- The page's CSP: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource} 'nonce-…'; img-src ${cspSource} data:; font-src ${cspSource}; worker-src blob:` — no `unsafe-inline` (the canvas's React Flow styles are set through the CSSOM, which the CSP allows; P2 verifies and fails loudly otherwise). `localResourceRoots`: `dist/` only.
- The page gets a `DraftView` (`toDraftView`): no absolute path, nothing Keep uses. Paths shown are project-relative.
- `parseDraftToHost` drops anything the draft on show does not offer (Keep where nothing can be kept, a scope or start not listed, the current scope again) and rebuilds the message from checked fields.
- The page runs no command and opens no URL; the host maps every id.

## 13. Work packages

Three packages, built in parallel, on **disjoint files**. Each codes against `src/types/draft.ts` (frozen; a change needs all three) and the signatures below. P3 imports P1's and P2's exports by these names; until they land P3 may stub them locally in its own test helpers only.

### P1 — pure draft services (vscode-free)

**Owns (new):** `src/services/draftModel.ts`, `src/services/draftDisplay.ts`, `src/services/draftTriggers.ts`; `test/unit/draftModel.test.ts`, `test/unit/draftDisplay.test.ts`, `test/unit/draftTriggers.test.ts`, `test/unit/draftNoVscode.test.ts`. Touches no existing file.

`draftDisplay.ts`:
- `displayFromTables(input: { name: string; layer: string; description?: string; tables: readonly SemanticTable[]; relationships: readonly Relationship[]; viewConfig?: ViewConfig; layers: readonly LayerConfig[] }): { display: DisplaySubjectArea; autoLayout: boolean }` — a v5 document in memory through core's own pipeline (`validateSubjectAreaDocument` → `buildUnifiedSubjectArea` with `getModel` over `tables` → `toLogicalStage` → `computeMissingPositions` → `toDisplaySubjectArea`, `readOnly: true`); table-level `relationships` stripped so each link is drawn once; `autoLayout` = no table positioned.
- `displayFromFiles(input: { files: Readonly<Record<string, string>>; domainPath: string }): Promise<{ display; autoLayout }>` — `loadDisplaySubjectArea` with an in-memory `readFile` (missing → `null`) and `dbml: dbmlStorageReader`, every limit set.
- `draftSchemas(tables: readonly { schema?: string }[]): DraftSchemaCount[]` (biggest first, then name). Schema filtering is the page's (P2), not here.

`draftModel.ts`:
- `DRAFT_LARGE_TABLES = 60`; `DRAFT_SCOPE_LIMIT = 12`; `DRAFT_OTHER_START_LABELS: Record<DraftOtherStart, string>` (`New Diagram…`, `Import…`, `Bring In Your Data Model…`, `Open an Example…`, `Open Folder…`); `KEEP_AS_DIAGRAM = 'Keep as Diagram'`, `KEEP_THIS_EXAMPLE = 'Keep This Example'`, `SAVE_THIS_EXAMPLE = 'Save This Example…'`, `DRAFT_REDRAWN_NOTICE`.
- `draftFromImportPlan(input: ImportPlanDraftInput): Draft` with `ImportPlanDraftInput = { plan: DbmlImportPlan; importSource: 'file' | 'sql' | 'semanticModel' | 'example'; trigger: DraftTrigger; target: DraftTarget; fileName: string; origin?: { from: string; notes?: readonly string[]; skipped?: readonly string[] } /* ImportDbmlOrigin's shape */; describe: DescribeDbmlImportOptions; libraryTable(name: string): SemanticTable | undefined; layers: readonly LayerConfig[]; logicalOnly: boolean; hasFolder: boolean; changeOptions: boolean; scopes?: DraftScopes; notice?: string }` — display from `plan.newTables` + `changedLibraryTables` + reused library tables and `plan.relationships`, `plan.document.viewConfig` (positions, stickies); summary from `plan.report`; details from `buildImportReview(plan, describe)` mapped to `DraftDetailSection`; banner per §2.1; `keep: { writer: 'importDbml', importSource, target, fingerprint: importPlanFingerprint(plan) }`. `source` = `sqlDdl` | `semanticModel` | `dbml` | `example` from `importSource`.
- `draftFromDbt(input: DbtDraftInput): Draft` with `{ draft: DbtDraft; relationships: readonly Relationship[] /* routed: every one drawn */; scope: DraftScope; scopes: readonly DraftScope[]; trigger; target; libraryTable; layers; notice? }`.
- `dbtDraftScopes(scopes: readonly DraftScope[]): { scopes: DraftScopes | undefined; defaultScope: DraftScope | undefined }` — folder scopes only, ranked by `folderRank`, count, path; at most `DRAFT_SCOPE_LIMIT`.
- `draftFromExampleProject(input: { id: string; title: string; files: Readonly<Record<string, string>>; startDiagram: string; tableCount?: number; trigger: DraftTrigger; hasFolder: boolean; scopes: DraftScopes }): Promise<Draft>` — `keep: { writer: 'exampleProject', exampleId }`.
- `exampleDbmlDraft(input: { dbmlText: string; fileName: string; trigger: DraftTrigger; scopes?: DraftScopes }): Promise<Draft>` — the no-folder coffee shop: `readDbml` + `readDbmlImportLayout` + `planDbmlImport` against an empty library and `DEFAULT_LAYERS`, `keep: { writer: 'none' }`, primary `openFolder`.
- `exampleScopes(current: string, projects: readonly { id: string; title: string; tables?: number }[]): DraftScopes` — `example:coffee-shop`, `exampleProject:<id>`; `parseExampleScope(id)`.
- `importPlanFingerprint(plan: DbmlImportPlan): string`, `dbtDraftFingerprint(draft: DbtDraft, relationships: readonly Relationship[]): string` — stable over table names, columns (name, type, keys), relationships (core `linkKey`), the diagram file; equal plans give equal strings whatever the order.
- `draftHeadline(…)`, `draftDetail(…)` exported for tests.

`draftTriggers.ts`:
- `type AutoDraft = 'find' | 'example'`; `autoDraftDue(input: { settingOn: boolean; state: { off?: boolean; answered?: boolean; draftShown?: boolean }; hasDiagrams: boolean; hasTables: boolean; canvasOpen: boolean; intent: StartIntent | undefined; exampleShownOnMachine: boolean }): AutoDraft | undefined` (§3.2).
- `draftSourceForIntent(intent: StartIntent): DraftSource | undefined` (`importSqlDdl` → `sqlDdl`, …, `drawFromDbt` → `dbt`).
- `walkthroughAutoOpens(input: { hasFolder: boolean; owed: boolean }): boolean`.
- `EXAMPLE_DRAFT_SHOWN_KEY = 'erdStudio.exampleDraftShown'`.

Tests: the 257-table `test/fixtures/sql-ddl/large/` converted (the engine from source) and planned → a large draft (`panelOpen`, `focusSchema` the biggest schema, counts equal `plan.report`, each relationship once); the coffee shop in a folder and with no folder (keep kinds, primaries, labels); every `docs/examples` project through `draftFromExampleProject` (table and relationship counts equal `test/golden/examples/<id>.json`'s); a dbt draft from `test/fixtures/dbt-project` (marts first, named after the folder, cap and `available`); fingerprints (order-independent, change on a column type); `parseDraftToHost` with every allowance (it lives in the contract; test it here); banner strings per §2.1 including singular and the notices; no dbt word in any non-dbt draft's strings; `autoDraftDue` truth table; `draftNoVscode.test.ts` asserts the three modules' import graph holds no `vscode` (as `cli.noVscode.test.ts` does).

### P2 — the preview (host class + page)

**Owns (new):** `src/providers/DraftPreviewPanel.ts`; `webview-draft/` (`index.tsx`, `DraftApp.tsx`, `components/DraftBanner.tsx`, `components/ScopeSwitcher.tsx`, `components/OtherStartsMenu.tsx`, `components/SchemaPanel.tsx`, `components/DetailsDrawer.tsx`, `lib/draftHost.ts` (the `acquireVsCodeApi` wrapper, the page's only one), `lib/draftLayout.ts`, `lib/filterDisplayToSchema.ts`, `styles/draft.css`); `test/unit/draftPreviewPanel.test.ts`, `test/unit/draftWebview.test.tsx`, `test/unit/draftLayout.test.ts`, `test/fixtures/draft/*.json` (hand-made `DraftView`s: small, large, dbt with scopes, example with no folder). **Edits:** `esbuild.js` (a sixth target, `webview-draft/index.tsx` → `dist/draft.js` + `dist/draft.css`, browser IIFE, React, `__ELK_WORKER_CODE__` define, in both the build and watch branches), `tsconfig.webview.json` (`include` `webview-draft/**/*`), `.vscodeignore` (`webview-draft/**`), `webview/lib/elkLayout.ts` and `webview/components/Toolbar/Toolbar.tsx` only to move the first-open layout's option building into a shared `webview/lib/firstOpenLayout.ts` (so the preview and the canvas lay out alike; the canvas's behaviour is unchanged), `test/unit/uiWordingSource.test.ts` (sweep `webview-draft/` too).

Exports:
- `createDraftPreview(extensionUri: vscode.Uri, events?: Partial<DraftPreviewEvents>): DraftPreview` (the contract's interface).
- `class DraftPreviewPanel` (singleton; `static currentPanel` for tests; `handleMessage(raw)`).
- `buildDraftPreviewHtml(input: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; title: string }): string` (pure).
- Page: `filterDisplayToSchema(display: DisplaySubjectArea, schema: string | undefined): DisplaySubjectArea`, `layoutDraft(display): Promise<Record<string, NodePosition>>` (the canvas's ELK, `firstOpenLayout` options).

Behaviour: `ask` opens the tab (`ViewColumn.Active`, `preserveFocus` for `sidebar`, `retainContextWhenHidden`, `localResourceRoots: [dist]`) or redraws the open one, posts `{ type: 'draft', view: toDraftView(draft) }` after `ready`, resolves on the first non-passive message as `DraftAnswer`'s doc in the contract says (`keep` → `busy` until `settle`; `scope` → `busy` until the next `ask`; the others dispose the tab first), `superseded` for an earlier pending ask, `closed` on dispose; validates every message with `parseDraftToHost(raw, draftAllowance(view), view.scopes?.current)` and logs the rest; reports `detailsOpened` / `layoutFailed` through `events`. The page: BEM classes (`draft-banner__headline`, …), colours from `packages/renderer/src/styles/theme.css` variables only, `ErdCanvas` with `logicalOnly`, the layout state, the schema panel (§2.3), the drawer (§2.4, text only), keyboard reachable buttons, the one primary button, the busy states (`Saving…`, `Drawing…`, `Laying out <n> tables…`), the notice line.

Tests: the HTML shell (nonce-only CSP, no `unsafe-inline`, no inline `style=` or `on…=` attribute, `worker-src blob:`, only `cspSource` URLs); the lifecycle (ask → ready → draft posted; each answer kind; settle true/false; supersede; dispose → closed; a message not allowed is dropped); the page with jsdom (`@vitest-environment jsdom`) for each fixture: banner text, which buttons, the switcher posts `scope`, the menu posts `otherStart` ids, the schema panel filters, the drawer renders sections as text; `filterDisplayToSchema`; `layoutDraft` options equal the canvas's first-open options; the esbuild target exists in both branches; `vsce ls` count stays ≤ 60 (CI's check; note the new count in the PR).

### P3 — wiring, removal, telemetry, docs

**Owns (edits):** `src/extension.ts`; `src/commands/importDbml.ts` (the `draft` seam, §5.1; `ImportDbmlResume.redraw`; the `quiet` UI; the modal kept as fallback; Review All… removed), `importSqlDdl.ts`, `importSemanticModel.ts` (pass `draft`; several models → `scopes` + `onScope`), `drawFromDbt.ts` (§5.2), `openExampleDiagram.ts`, `openExampleProject.ts` (§9: the one command, the switcher, `Save This Example…` resume), `start.ts`, `src/services/startSuggestion.ts` (§3.3: Show Me, the new strings, `runNothingFoundPrompt` removed, `draftShown` in the state), `activationPrompts.ts` (`draft`, `exampleOpen`, no `nothingFound`), `importReview.ts` (HTML and protocol removed; the builders kept), `importGuide.ts` (`from: 'draft'`), `telemetryPayload.ts`; `src/providers/GettingStartedPanel.ts` + `src/types/gettingStarted.ts` (§10: no start card; **How-to clips** section), `src/types/startActions.ts` (only what the behaviour needs; labels unchanged), `package.json` (Open an Example… title, `openExampleDiagram` hidden, viewsWelcome / walkthrough links that now open drafts — behaviour only, wording is Simplify's), `telemetry/src/index.js`, `telemetry.json`, `telemetry/README.md`; docs `docs/dev/onboarding-and-cli.md`, `docs/dev/architecture.md` (Activation, the sixth esbuild target), `docs/dev/dbml.md` (the dry run is the draft), `CLAUDE.md` (architecture map row, Read-before-touching row for this file), `CHANGELOG.md` (`## Unreleased`); unit tests that change with these (`quickImport`, `importReview`, `startSuggestion`, `startActions`, `extension.activate`, `gettingStartedPanel`, `openExampleDiagram`, `openExampleProject`, `dbtAddonSurfaces`, `uiWording`, `sidebarLayout`, `importDbml.activate`, `dbtDraft`/`drawFromDbt` tests, `telemetry` contract tests). **Deletes:** `src/providers/ImportReviewPanel.ts`.

Does: §3 triggers and gate (the `sidebar` trigger in `onEmptyDiagramsViewShown`, using `autoDraftDue` and the view progress bar; explicit starts pass `draft` with their trigger; `walkthroughAutoOpens`; Keep sets the nudge flag; `exampleOpen` claim); §5 seams; §6; §9; §10 removals; §11 keys (and the existing source keys kept firing); the host table `DRAFT_OTHER_START_COMMANDS` (fixed); one `createDraftPreview` per extension host, shared by every flow, passed through deps; `generation()` from the existing semantic-dir watchers (external changes only, `ownWrites` excluded). Tests per changed behaviour: the activate test's "draft-first" block (icon → draft due → one draft, gate claimed, flags written before show, quiet failure counts `draftUnavailable`, never on activation's path, never in a folder with a diagram, table or canvas, example once per machine), Show Me → draft, Don't Ask Again → no draft and no walkthrough, Keep → the same files as today's quick import (byte-for-byte against the existing `quickImport.test.ts` expectations), Change options… → preselected flow ending in a draft, staleness redraw, dbt scope switch, every `DraftOtherStart` → its fixed command, telemetry keys present in all three places (the existing contract test).

### 13.1 What the later Simplify stage owns (P3 must not half-do it)

Words and visuals, after P1–P3 merge: every label of one action unified (`START_LABELS`, `START_PICK_ITEMS`, `package.json` titles, walkthrough step titles: Create Diagram / Import your SQL scripts / Start from your SQL scripts…, New Diagram / Start blank / Start your data model…, See how to bring it in / Show Me How / Bring In Your Data Model…); the sidebar welcome views cut to a sentence, one button, at most two links and no rhetorical question; "Each table is a file in .erd-studio/ you can commit" said once; the "(DBML, an open format, no lock-in; SQL DDL scripts; or a Power BI semantic model)" parenthetical removed from the ~12 strings; "ERD Studio is free to use." out of toasts and the guide's intro; the upgrade notice without five assistant names; two tabs called Welcome and the tour's six names; the tour no longer autoplaying with sound; the walkthrough subtitle cut off; the tour poster's "Install ERD Studio"; the clips' first frames; "pick up to 15 of 9" in the dbt picker; the canvas's zoom jump to 200% after the first table; the canvas's first-open layout of a 257-table diagram; jargon in example details and in the fallback modal; the How-to clips section's title and copy.

### 13.2 Not in P1–P3

- **Detection** (its own stage; files P3 must not edit beyond imports): `src/services/importSources.ts` (`CREATE_TABLE`: `table\s+(?:if\s+not\s+exists\s+)?ID(?:\s*\.\s*ID){0,2}\s*\(` with `ID = [\p{L}_][\p{L}\p{N}_$#@]*|"…"|` + "`…`" + `|\[…\]` and the `u` flag, or `sqlDdlImport`'s statement splitter; skip `-- Databricks notebook source` files and `/macros/`; pg_dump `COPY … \.` and `INSERT` lines stripped before the size check; no Oracle suggestion; ERD Studio's own exports (`ERD_STUDIO_DBML_HEADER_PREFIX`); UTF-16 by BOM; `**/*.[sS][qQ][lL]`-style globs in the look and in `activationEvents`; ~200 `.sql` listed and ranked `ddl|schema|tables?|create|V\d+__|migration` first; one shared listing for the look and the quick import), `src/commands/startIntent.ts` (one retry of a timed-out look), dbt discovery (deeper, dot-folders, symlinks, upward like the CLI, not silent), `sqlDdlImport.ts` (ALTER TABLE ADD / RENAME / DROP COLUMN in file order, or a warning), and its telemetry (per-window activation; tooling found `dbt_project.yml` but the session has no dbt).
- **Stories** (`test/stories/**`): the first-60-seconds stories for each row of §4 (the six How-to clips and `--publish` were removed in favour of Show Me Around).

## 14. The onboarding guide on the draft

**Show Me Around** (`docs/dev/onboarding-and-cli.md` → Show Me Around; `src/types/onboardingGuide.ts`) runs its phase A on the first draft shown on a machine: coach marks on the banner (the draft's own source phrase, `DraftBanner.from`, and its counts), on More ways to start (Import… and Bring In Your Data Model…, where the user's data model can come from) and on the control that keeps the draft, which the guide waits for. The contract carries it as `DraftToWebview` `guide`, a passive `DraftToHost` `guide` (`step` / `skip` only), `DraftPreview.startGuide` and `DraftPreviewEvents.guide`; the page's guide never writes, runs or opens anything, and a draft without it is unchanged. Keep then opens the diagram, where phase B continues on the canvas. A project that already has diagrams shows no draft, so phase A never runs there by itself: the one-time diagrams notice ("This project has N ERD Studio diagrams.") carries a **Show Me Around** button after **Open <diagram>** (before 2.0, after **Convert to DBML…** and **Open <diagram>**), which opens that diagram with phase B on it.

## 15. Risks

- **React Flow without `style-src 'unsafe-inline'`.** The canvas webview allows it; the draft page must not. If React Flow injects a `<style>` element, P2 nonces it (React Flow reads `nonce` from the `ReactFlow` prop in newer versions; else the injected sheet is replaced by the bundled `dist/draft.css`) and says so.
- **Bundle size.** `dist/draft.js` repeats React, React Flow, the renderer and the ELK worker (several MB). Accepted for isolation (the editor webview's protocol and allowlist stay untouched); revisit with a shared chunk if the VSIX size matters.
- **Automatic tab.** Opening an editor tab on the icon click is the boldest change; the rules (once per folder, once per machine for the example, quiet failures, gate) keep it to one tab per folder at most. Telemetry (`draftShownAuto` → `draftKept` / `draftDiscarded` / `draftClosed`) says whether it helps.
- **Staleness.** Keep re-plans when the semantic dir changed; a change elsewhere (the SQL files themselves) is not tracked: the plan written is the plan shown, as with today's modal.
- **Quiet runs** must not count the import's `*Cancelled` keys, or the funnel reads every automatic failure as a user cancel.
