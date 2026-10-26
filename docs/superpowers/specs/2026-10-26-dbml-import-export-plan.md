# DBML import and export (round trip) — Plan

**Date:** 2026-10-26
**Prompted by:** @gbrueckl's customer is wary of ERD Studio's "proprietary nature": if development stops, are their models stranded? Gerhard suggested DBML and keeping layout separate from the model.
**Builds on:** [2026-10-09 storage formats spec](2026-10-09-serialization-formats-dbml-design.md) (v1 export shipped; storage decisions 1–4 stand).
**Status:** Plan — not started.

## Goal

A team can move its models **into** ERD Studio from DBML and **out** of ERD Studio to DBML at any time, **layout included**, without losing ERD Studio's modelling fields. If ERD Studio ever stopped, a project would be one command away from dbdiagram.io:

```sh
npm install -g dbdiagram
dbdiagram auth login
dbdiagram push silver.dbml --name "Silver"   # picks up silver.dbdiagram (positions) next to it
```

## Non-goals

- **No change to storage.** YAML + JSON stay canonical (2026-10-09 decisions 1–4).
- **No DBML mirror file** written on save (decision 4). Teams can still pipe `erd-studio export` in CI.
- **ERD Studio never talks to dbdiagram's servers.** We write files; the user runs dbdiagram's own CLI under their own account.
- **No writing CLI subcommand, no `--out`.** The CLI stays read-only (stdout only).
- **v1 DBML export is not changed.** It stays the portable, notes-only format (parser floor `@dbml/core` 2.4.2).

## Decisions

1. **Two DBML export formats.** `dbml` (v1, unchanged, maximum portability) and a new **`dbml-rich`** (v2): ERD fields as DBML custom properties, readable as real fields and filters in dbdiagram/dbdocs. v2 needs a DBML **9.1+** parser — the reason v1 dropped custom properties on 2026-10-09 still holds for v1.
2. **Custom property values are always quoted strings** (`scd_type: '2'`, never `2`). Unquoted typed values exist only from DBML 11.0 and break every 9.x/10.x reader; quoted strings parse in 9.1 → 11.0.
3. **Refs use the optional form** `>?` / `?<` / `-?`. Since DBML 9, a bare `>` asserts the FK is NOT NULL, which ERD Studio doesn't record (a bare `>` gives an info diagnostic per FK in dbdiagram). One-to-one FK columns get `unique`.
4. **One flattened `.dbml` per subject area** (no `use` imports) — the only multi-tool-safe shape. "Export all" writes one file per subject area.
5. **Layout travels in a sidecar next to the `.dbml`.** Preferred: dbdiagram's `<name>.dbdiagram` (v3: `defaultView.tablePositions[{name, schemaName, x, y}]`), so `dbdiagram push` carries positions. **Gated on Phase 0** (Holistics' OK). Fallback: our own documented `<name>.dbml.layout.json` in the same `{name, schemaName, x, y}` shape as their public API.
6. **Import is an editor command, not a CLI subcommand or AI-only flow.** `ERD Studio: Import DBML…`, built like Draw from dbt: a vscode-free planner in `src/services/dbmlImport.ts`, files created via the same path Draw from dbt uses (`saveTable`, domain file written with `wx`, `ownWrites`, rollback on failure).
7. **Parser: `@dbml/parse` only, exact pin, extension bundle only.** ~432 KB bundled (vs 15.7 MB for `@dbml/core`). Never a runtime dependency of `@erd-studio/core` (runtime deps stay `yaml` only). Core already pins `@dbml/parse` 10.2.0 as a devDependency for golden checks.
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

- [ ] Email Holistics: "ERD Studio would like to write `<name>.dbml` + `<name>.dbdiagram` so users can `dbdiagram push` them with your CLI — OK with you?" Their ToS §2.6 forbids reverse engineering; build only from their public API docs, their CLI docs and a file `dbdiagram pull` writes from Liam's own diagram. **No code copied from their CLI.**
- [ ] `dbdiagram pull` one of Liam's own diagrams (incl. a table with no schema) → commit as a fixture; confirm `schemaName` for unqualified tables.
- [ ] Decide the parser pin (`@dbml/parse` 10.3.1 or 11.0.x) after checking 11.0's typed-value output against the import normaliser.
- [ ] Settle the open questions below.

### Phase 1 — rich export

- [ ] `packages/core`: `toDbmlRich(domain)` and `toDbdiagramLayout(domain)` (or `toDbmlLayout`), pure string/JSON builders over the shared traversal in `exportShared.ts`; add `'dbml-rich'` to `DiagramExportFormat` (additive → package PATCH).
- [ ] Goldens for every core fixture: parse with `@dbml/parse` 9.1, 10.x and 11.0 (exact-pinned devDependencies, as v1 does), **zero diagnostics** via `DBMLDiagnosticsProvider`, layout JSON golden.
- [ ] **Export Diagram…**: new "DBML (rich, with layout)" choice; Save As writes the `.dbml` and its sidecar side by side; Copy/Open give the DBML only.
- [ ] **Export All Diagrams…** (new command, `NO_LEGACY_ALIAS`): pick a folder, one `.dbml` + sidecar per subject area.
- [ ] CLI: `export --format dbml-rich`, `--format dbml-layout`, and `--all` (JSON list of `{ fileName, content }` on stdout). Read-only, no `--out`.
- [ ] Fix the prototype's known bugs: quote role names with spaces; sticky-note colours must be hex; composite FKs as one Ref; nested meta as JSON.

### Phase 2 — import

- [ ] `src/services/dbmlImport.ts`: pure planner (raw DBML model + optional positions + library snapshot → planned table files, subject-area document, report). No `vscode`.
- [ ] `ERD Studio: Import DBML…` command (palette + sidebar), modelled on `drawFromDbt.ts`: file picker, layer + name prompts, dry-run summary, write, open the new diagram. `NO_LEGACY_ALIAS`; works without dbt (`erdStudio.projectPath`).
- [ ] Bundle `@dbml/parse` into `dist/extension.js` only (check `cli.noVscode` and VSIX file count unaffected).
- [ ] Unit tests: the mapping table row by row; foreign DBML from dbdiagram's samples (inline refs, composite refs, partials, enums, optional refs, schema-qualified names, odd names); collisions with an existing library; v5 vs v6 naming projects; folder-grouped libraries.

### Phase 3 — round trip and hardening

- [ ] Round-trip test over every core fixture: `toDbmlRich` → planner → equal on every covered field (documented exceptions only: YAML comments, the `compositeKey` label, zero-column tables).
- [ ] Zero-column tables: DBML rejects them — export a placeholder column with a property marking it, and drop it on import.
- [ ] Manual check: push a rich export with `dbdiagram push` and confirm positions; pull it back and import.

### Phase 4 — docs, harness, telemetry, release

- [ ] Telemetry FEATURES (additive; Worker + `telemetry.json` deployed first): `exportDbmlRich`, `exportAll`, `importDbml`, `importDbmlLayout`, `importDbmlCancelled`; error `importDbmlFailed`. No names or paths.
- [ ] Harness: point assistants at **Import DBML…** in `SCHEMA_CONTENT` (closes the 2026-10-09 "DBML import guidance" item); bump `HARNESS_VERSION`; regenerate the fixture harness files in the same PR.
- [ ] Docs: a "Leaving ERD Studio" page (export all → `dbdiagram push`), update the 2026-10-09 spec's open items, README mention, CHANGELOG under `## Unreleased`.
- [ ] Ship as patch releases (export first, import second). Packages: additive → automatic PATCH.

## Open questions for Liam

1. **Property names:** plain (`grain`, `role`, `scd_type` — nicest as dbdiagram filters) or prefixed (`erd_grain` — no clash with a team's own properties)? Recommendation: plain on export, accept both on import.
2. **Layout file:** commit to `.dbdiagram` only after Holistics replies, or ship our own `.dbml.layout.json` first and add `.dbdiagram` later?
3. **Confluence export panel:** add "DBML (rich)" there too, or extension and CLI only for now?
4. **Import into an existing diagram** (add tables to the open canvas) — later, or part of v1 of import? (It needs a message type, payload validation and `applySubjectAreaEdit`.)
