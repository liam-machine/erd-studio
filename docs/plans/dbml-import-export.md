# DBML import and export (round trip) — Plan

**Date:** 2026-10-26
**Prompted by:** @gbrueckl's customer is wary of ERD Studio's "proprietary nature": if development stops, are their models stranded? Gerhard suggested DBML and keeping layout separate from the model.
**Builds on:** the v1 Mermaid / DBML export (`packages/core/src/exportDbml.ts`, shipped 2026-10-09).
> **Superseded by `docs/plans/native-dbml-storage.md` (2.0 native storage).** Since ERD Studio 2.0, DBML is the storage itself, not only a way in and out; the export and import described here are unchanged and still the route to dbdiagram.io. The history below stays as written.

**Status:** Implemented (2026-10-26, branch `feat/dbml-import-export`, one PR into develop). Left: the manual dbdiagram.io check ("What remains manual") and the release. User doc: `docs/leaving-erd-studio.md`; developer notes: `docs/dev/dbml.md`.

## Goal

A team can move its models **into** ERD Studio from DBML and **out** of ERD Studio to DBML at any time, **layout included**, without losing ERD Studio's modelling fields. If ERD Studio ever stopped, a project would be one command away from dbdiagram.io:

```sh
npm install -g dbdiagram
dbdiagram auth login
dbdiagram push silver.dbml --name "Silver"   # picks up silver.dbdiagram (positions) next to it
```

## Non-goals

- **No change to storage.** YAML + JSON stay canonical: no DBML storage, no pluggable storage format.
- **No DBML mirror file** written on save (two sources of truth, merge conflicts in a generated file). Teams can still pipe `erd-studio export` in CI.
- **ERD Studio never talks to dbdiagram's servers.** We write files; the user runs dbdiagram's own CLI under their own account.
- **No writing CLI subcommand, no `--out`.** The CLI stays read-only (stdout only).
- **v1 DBML export is not changed.** It stays the portable, notes-only format (parser floor `@dbml/core` 2.4.2).

## Decisions

1. **Two DBML export formats.** `dbml` (v1, unchanged, maximum portability) and a new **`dbml-rich`** (v2): ERD fields as DBML custom properties, readable as real fields and filters in dbdiagram/dbdocs. v2 needs a DBML **9.1+** parser — v1 stays notes-only because parsers older than 9.1 reject custom properties.
2. **Custom property values are always quoted strings** (`scd_type: '2'`, never `2`). Unquoted typed values exist only from DBML 11.0 and break every 9.x/10.x reader; quoted strings parse in 9.1 → 11.0.
3. **Refs use the optional form** `>?` / `?<` / `-?`. Since DBML 9, a bare `>` asserts the FK is NOT NULL, which ERD Studio doesn't record (a bare `>` gives an info diagnostic per FK in dbdiagram). One-to-one FK columns get `unique`.
4. **One flattened `.dbml` per subject area** (no `use` imports) — the only multi-tool-safe shape. "Export all" writes one file per subject area.
5. **Layout travels in a sidecar next to the `.dbml`:** dbdiagram's `<name>.dbdiagram` (v3: `defaultView.tablePositions[{name, schemaName, x, y}]`), so `dbdiagram push` carries positions. *(Resolved: Liam chose to commit to `.dbdiagram`, with no Holistics gate and no `.dbml.layout.json` fallback.)*
6. **Import is an editor command, not a CLI subcommand or AI-only flow.** `ERD Studio: Import DBML…`, built like Draw from dbt: a vscode-free planner in `src/services/dbmlImport.ts`, files created via the same path Draw from dbt uses (`saveTable`, domain file written with `wx`, `ownWrites`, rollback on failure).
7. **Parser: `@dbml/parse` only, exact pin, extension bundle only.** 10.3.1, a root dependency; about 434 KB in `dist/extension.js` (vs 15.7 MB for `@dbml/core`), none in `dist/cli.js`. Never a runtime dependency of `@erd-studio/core` (runtime deps stay `yaml` only). Core's devDependencies pin 9.1.1 (`dbml-parse-v9`), 10.3.1 and 11.0.0 (`dbml-parse-v11`) for the golden checks.
8. **No positions is a first-class case.** An imported subject area with `viewConfig: {}` gets ELK auto-layout on first open, saved as one undo step — already how Draw from dbt works.
9. **Existing library tables are reused, never overwritten.** Same as Draw from dbt (`libraryHas` → reused). Case-only differences take the library's spelling.

## Mapping

### Export (`dbml-rich`)

| ERD Studio | DBML |
|---|---|
| header | `// erd-studio dbml-export v2 (DBML 9.1+)` + a line naming the layout file + a line on `>?` |
| subject area, description | `Project <name> { Note: … }` |
| layer | `TableGroup <layer> [color: <layer colour>]` |
| table, schema | `Table [schema.]name` (never `as`) |
| description | table `Note:` |
| tableRole, grain, alias | `role`, `grain`, `alias` properties |
| rationale.* | `rationale_<snake_case>` properties (triple-quoted when multi-line) |
| flat meta | `meta_<key>` properties |
| nested meta | JSON string in `meta_<key>` (round-trips; opaque to other tools) |
| PK / composite PK | `[pk]` / `indexes { (a, b) [pk] }` |
| isNaturalKey, scdType, additiveType | `natural_key: 'true'`, `scd_type`, `additive_type` |
| relationship | `Ref [role]: from.col >? to.col` |
| composite FK | one `Ref: a.(x, y) >? b.(u, v)` |
| sticky note | `Note sticky_<n> [color: #hex] { … }` (positions in the sidecar) |
| positions | sidecar (decision 5) |

### Import

- Parse with `@dbml/parse` (`MemoryProjectLayout` → `Compiler` → raw model). Normalise custom-property values from both shapes: plain string (≤ 10.x) and `{ value, type }` (11.x).
- **Our own keys** (above, also accepted with an `erd_` prefix) map back to their fields.
- **Everything else DBML has and we don't** goes into `meta.dbml` (not null, default, unique, increment, check, enums, non-PK indexes, header colour) or is dropped and listed in the import report (Records, Ref delete/update/colour, `inactive`, `database_type`).
- `TablePartial` is expanded into each table (the raw model doesn't do it). Optional refs (`>?`) become plain cardinalities — ERD Studio has no optionality.
- Names are checked against `TABLE_NAME_PATTERN` / `COLUMN_NAME_PATTERN` and `findTableNameIgnoringCase`; an invalid name is sanitised with the original kept (`alias` for tables, `meta.dbml.name` for columns) and listed in the report. Two tables differing only by schema or case → `{schema}_{name}` with `alias`.
- Relationships go through `canonicalRelationship` (FK side) and `routeToLibrary` / domain `logical.relationships` per `usesLibraryRelationships`; composites become one entry per column pair sharing `compositeKey`.
- Layer: chosen in the command, defaulting to a TableGroup or schema name that matches a layer id. Subject-area name defaults to the `Project` name or file name; refuse if the file exists.
- Positions: a sibling `.dbdiagram` or `.dbml.layout.json` if present (re-keyed to the imported names), else none → auto-layout. Tables missing from a partial sidecar are placed by `computeMissingPositions`.
- A dry-run summary before writing: tables new / reused, relationships, what was dropped.

## Phases

### Phase 0 — groundwork

- [x] ~~Email Holistics: "ERD Studio would like to write `<name>.dbml` + `<name>.dbdiagram` so users can `dbdiagram push` them with your CLI — OK with you?" Their ToS §2.6 forbids reverse engineering; build only from their public API docs, their CLI docs and a file `dbdiagram pull` writes from Liam's own diagram. **No code copied from their CLI.**~~ Not needed: Liam chose to commit to `.dbdiagram` without waiting. The ToS rule still holds — built only from the public docs and the pulled file, never from their CLI's code.
- [x] `dbdiagram pull` one of Liam's own diagrams (incl. a table with no schema) → commit as a fixture; confirm `schemaName` for unqualified tables.
- [x] Decide the parser pin: **10.3.1** bundled; the normaliser also reads 11.0's `{ value, type }` property shape, and the tests run 9.1.1, 10.3.1 and 11.0.0.
- [x] Settle the open questions below.

### Phase 1 — rich export

- [x] `packages/core`: `toDbmlRich(domain)` and `toDbdiagramLayout(domain)` (or `toDbmlLayout`), pure string/JSON builders over the shared traversal in `exportShared.ts`; add `'dbml-rich'` to `DiagramExportFormat` (additive → package PATCH).
- [x] Goldens for every core fixture: parse with `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0 (exact-pinned devDependencies, as v1 does), no errors or warnings (lint infos only where the model itself causes them, `MODEL_LINT_INFOS`), layout JSON golden.
- [x] **Export Diagram…**: new choice, labelled **DBML for dbdiagram.io**; Save As writes the `.dbml` and its sidecar side by side; Copy/Open give the DBML only.
- [x] **Export All Diagrams…** (new command, `NO_LEGACY_ALIAS`): pick a folder, one `.dbml` + sidecar per subject area.
- [x] CLI: `export --format dbml-rich`, `--format dbml-layout`, and `--all` (JSON list of `{ fileName, content }` on stdout). Read-only, no `--out`.
- [x] Fix the prototype's known bugs: quote role names with spaces; sticky-note colours must be hex; composite FKs as one Ref; nested meta as JSON.

### Phase 2 — import

- [x] `src/services/dbmlImport.ts`: pure planner (raw DBML model + optional positions + library snapshot → planned table files, subject-area document, report). No `vscode`.
- [x] `ERD Studio: Import DBML…` command (palette + sidebar), modelled on `drawFromDbt.ts`: file picker, layer + name prompts, dry-run summary, write, open the new diagram. `NO_LEGACY_ALIAS`; works without dbt (`erdStudio.projectPath`).
- [x] Bundle `@dbml/parse` into `dist/extension.js` only (check `cli.noVscode` and VSIX file count unaffected).
- [x] Unit tests: the mapping table row by row; foreign DBML from dbdiagram's samples (inline refs, composite refs, partials, enums, optional refs, schema-qualified names, odd names); collisions with an existing library; v5 vs v6 naming projects; folder-grouped libraries.

### Phase 3 — round trip and hardening

- [x] Round-trip test over every core fixture: `toDbmlRich` → planner → equal on every covered field (documented exceptions only: YAML comments, the `compositeKey` label, zero-column tables). Done in `test/unit/dbmlRoundTrip.test.ts`, which lists every exception with its reason, and also checks that a second export is the first one again.
- [x] Zero-column tables: DBML rejects them — export a placeholder column with a property marking it, and drop it on import.
- [ ] Manual check: push a rich export with `dbdiagram push` and confirm positions; pull it back and import.

### Phase 4 — docs, harness, telemetry, release

- [x] Telemetry FEATURES (additive; Worker + `telemetry.json` deployed first): `exportDbmlRich`, `exportAll`, `importDbml`, `importDbmlLayout`, `importDbmlCancelled`, `importDbmlInvalid`; error `importDbmlFailed`. No names or paths. **Deploy the Worker before the extension release.**
- [x] Harness: point assistants at **Import DBML…** in `SCHEMA_CONTENT`; bump `HARNESS_VERSION`; regenerate the fixture harness files in the same PR. (v33: a "DBML: import and export" section — the command, the dbdiagram.io export, the CLI formats, `dbdiagram push` only on request, keep `meta.dbml`.)
- [x] Docs: a "Leaving ERD Studio" page (export all → `dbdiagram push`), README mention, CHANGELOG under `## Unreleased`. (`docs/leaving-erd-studio.md`, `docs/dev/dbml.md`, the `meta.dbml` note in `docs/semantic-domain-json-reference.md`.)
- [ ] Ship as a patch release (export and import together, in one PR — Liam's decision 5). Packages: additive → automatic PATCH.

## Open questions for Liam — resolved 2026-10-26

1. **Property names:** plain (`grain`, `role`, `scd_type` — nicest as dbdiagram filters) or prefixed (`erd_grain` — no clash with a team's own properties)? Recommendation: plain on export, accept both on import.
   **Answer: go with the recommendation** — plain on export; import accepts plain and `erd_`-prefixed.
2. **Layout file:** commit to `.dbdiagram` only after Holistics replies, or ship our own `.dbml.layout.json` first and add `.dbdiagram` later?
   **Answer: commit to `.dbdiagram`** — no `.dbml.layout.json`, no Holistics gate.
3. **Confluence export panel:** add "DBML (rich)" there too, or extension and CLI only for now?
   **Answer: whatever is easiest for the user to understand.** The Confluence app lives in the private repo and was not touched; core exports the new functions (additive, PATCH) for it to adopt. In the extension the choice is labelled **DBML for dbdiagram.io**, next to plain **DBML** for older tools.
4. **Import into an existing diagram** (add tables to the open canvas) — later, or part of v1 of import? (It needs a message type, payload validation and `applySubjectAreaEdit`.)
   **Answer: later.** Import always creates a new subject area. It reads ERD Studio's own rich exports **and** DBML from other software (dbdiagram.io and other tools).

## Phase 0 findings

- **The pulled file** (`dbdiagram pull` of Liam's own diagram, committed as `packages/core/test/dbdiagram-pull/` and `test/fixtures/dbml/dbdiagram-pull/`): `version` is the **string** `"3.0.0"`; top-level `darkMode`, `gridEnabling`, `currentViewName`, `defaultView` (`detailLevel`, `relationshipMode`, `tablePositions`, `tableGroupCollapseStates`, `stickyNoteLayouts`, `referencePaths`) and `views`. The writer leaves out `darkMode` and writes the arrays other than `tablePositions` empty.
- **Unqualified tables** have `schemaName: "public"`. DBML itself reads `Table public.x` as a table with no schema, so the rich export also writes a `schema: 'public'` property for a model really in `public`, and import reads it back.
- **Sticky-note layouts:** their shape is unknown (the pulled diagram had none), so sticky positions are not written; the reader accepts entries loosely. Import places sticky notes in a row above the tables.
- **The pulled `.dbml` kept ERD Studio's `//` header**, so a diagram pushed and pulled back is still read as ERD Studio's own export (to confirm in the manual check).
- **Parsers:** custom properties are plain strings in 9.x / 10.x and `{ value, type }` in 11.0; an optional end gets relation `'0..1'`; refs declared in a `TablePartial` are missing from the raw model in every version, so the reader rebuilds them.

## What remains manual

- [ ] `dbdiagram push` a rich export (Export All → DBML for dbdiagram.io) to Liam's dbdiagram.io account and confirm the positions; then `dbdiagram pull` it and import it with **Import DBML…**. Needs Liam's account.
- [ ] Once a pulled diagram has sticky notes, read its `stickyNoteLayouts` shape and decide whether sticky positions should travel (writer in `packages/core/src/dbdiagramLayout.ts`, reader already tolerant).
