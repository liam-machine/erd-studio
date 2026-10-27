# DBML import and export

> Read before touching the rich DBML export, the dbdiagram layout file, **Export All Diagrams…**, `erd-studio export --format dbml-rich|dbml-layout|--all` or **Import DBML…**. The user-facing page is `docs/leaving-erd-studio.md`; the plan and its decisions are `docs/plans/dbml-import-export.md`.

ERD Studio's YAML and JSON stay the only storage. DBML is a way out (the rich export plus its `.dbdiagram` layout, ready for `dbdiagram push`) and a way in (**Import DBML…**, which always creates a new subject area). Nothing writes a DBML mirror on save, and ERD Studio never contacts dbdiagram.io.

## Where things live

| Piece | File | Notes |
|---|---|---|
| Property names | `packages/core/src/dbmlRichProperties.ts` | **The one table** of DBML custom-property names (`DBML_RICH_TABLE_PROPERTIES`, `DBML_RICH_COLUMN_PROPERTIES`, `DBML_RICH_NOTE_PROPERTIES`, the `rationale_` / `meta_` / `sticky_` / `erd_` prefixes, `meta_json`, the placeholder column and property, the sticky colour hexes and `stickyColourOfHex`). The exporter and the importer both read it; never write one of these strings anywhere else |
| Rich export | `packages/core/src/exportDbmlRich.ts` | `toDbmlRich(area, { layoutFileName? })`, format `'dbml-rich'` of `exportDiagram`. Its header comment is the full mapping table |
| Layout file | `packages/core/src/dbdiagramLayout.ts` | `toDbdiagramLayout` / `serializeDbdiagramLayout` (writer), `readDbdiagramLayout` (reader, never throws, reports `problems`), `dbdiagramLayoutFileName` |
| Shared file names | `packages/core/src/exportFileName.ts` | internal; keeps the `.dbml` and `.dbdiagram` base names equal |
| Host export | `src/services/diagramExport.ts` | `exportSubjectAreaFile` / `exportSubjectAreaFiles` (no `vscode`): the one read behind **Export Diagram…**, **Export All Diagrams…** and the CLI, so their bytes match. Places unpositioned tables with `computeMissingPositions` (nothing written) and takes the `LayerService` for the `TableGroup`'s colour and label |
| Commands | `src/commands/exportDiagram.ts`, `src/commands/exportAllDiagrams.ts` | injectable UI. Save As of the rich format writes the `.dbml` and the `.dbdiagram` side by side; Copy / Open give the DBML alone |
| CLI | `src/cli/export.ts`, `src/cli/args.ts` | `--format dbml-rich`, the CLI-only `--format dbml-layout`, `--all`. Stdout only, no `--out` |
| DBML reader | `src/services/dbmlImportParse.ts` | `readDbml(text)` → a normalised `DbmlModel` or 1-based diagnostics, never throws. Reads property values in both shapes (a string in 9.x / 10.x, `{ value, type }` in 11.x), expands `TablePartial`s, rebuilds inline refs (and refs declared in a partial), detects ERD Studio's own export by its header |
| Import planner | `src/services/dbmlImport.ts` | pure (no `vscode`, no `fs`): `analyseDbml` (prompt defaults), `planDbmlImport` (new tables, reused names, relationships, changed library tables, the subject area document, a report), `serializeDbmlImportDocument` (v5 or v6 naming), `describeDbmlImportPlan` (the dry-run text). Its header comment is the reverse mapping, the `meta.dbml` keys and what is dropped |
| Import command | `src/commands/importDbml.ts` | file → read (+ `<base>.dbdiagram` beside it) → `readDbml` → layer → name → dry run → write → open. Injectable UI |
| Writer | `src/services/newSubjectAreaWriter.ts` | `writeNewSubjectArea`: the all-or-nothing write and rollback **Draw from dbt…** and **Import DBML…** share (`saveTable`, the subject area file with `wx`, then changed library tables, `ownWrites` after each write). Never fork it |

## Parser

- `@dbml/parse` **10.3.1**, exact pin, a root `dependency`, bundled into `dist/extension.js` only (about 430 KB). It is never in `dist/cli.js` (`test/unit/cli.noVscode.test.ts` asserts it) and never a runtime dependency of `@erd-studio/core`, whose only runtime dependency stays `yaml`. The VSIX is packed with `--no-dependencies`, so nothing ships from `node_modules`.
- Tests read every rich export with 9.1.1 (`dbml-parse-v9`), 10.3.1 and 11.0.0 (`dbml-parse-v11`), core devDependencies hoisted to the root. The helpers are in `packages/core/test/exportParsers.ts` (`parseDbmlRich`, `readDbmlRich`, `RICH_DBML_PARSERS`, `MODEL_LINT_INFOS`). The v1 `toDbml` floor is still `@dbml/core` 2.4.2, and v1 is unchanged.

## Rules

- **Custom-property values are always quoted strings** (`scd_type: '2'`): unquoted typed values exist only from DBML 11.0 and break every 9.x / 10.x reader.
- **Every rich golden parses with no error and no warning** in all three parsers, and all three read it the same. Lint infos are allowed only where the model itself causes them (`MODEL_LINT_INFOS`).
- **Refs are written from the FK end** (a one-to-one from its key end: DBML, and the SQL its tools generate, read a one-to-one's second end as the FK), with `?` on an end that is not all primary-key columns (DBML 9+ reads a bare `>` as NOT NULL, which ERD Studio does not record). Import treats `?` as a plain cardinality.
- **The layout file** follows the shape of a file `dbdiagram pull` wrote from Liam's own diagram (`packages/core/test/dbdiagram-pull/`): `version` the string `"3.0.0"`, no `darkMode`, `schemaName: "public"` for a table with no schema, and `stickyNoteLayouts`, `referencePaths`, `tableGroupCollapseStates` written empty. The sticky-note layout shape is unknown, so sticky positions do not travel; the reader accepts entries loosely.
- **Built only from public documentation and that pulled file.** dbdiagram's terms forbid reverse engineering: never read or copy code from the dbdiagram CLI package.
- **Import always creates a new subject area.** Library tables are reused, never overwritten, in the library's spelling. `isForeignKey` comes only from the `foreign_key` property, never from Refs. What DBML has and ERD Studio does not goes under `meta.dbml` (documented in `docs/semantic-domain-json-reference.md`); the rest is dropped and listed in the report.
- **ERD Studio's own export is read more trustingly** (its header, `ERD_STUDIO_DBML_HEADER_PREFIX`): any role text is kept, a one-to-one Ref's second end is the FK (the export writes it key end first, as DBML reads it, even when the keys say otherwise), and a sticky note linked to a table not in the diagram keeps the link. A foreign file gets only known roles, a key heuristic for one-to-one direction, and a dropped dangling link.
- **Import accepts each property with an `erd_` prefix** (`erd_grain`) as well as plain; export writes plain names.
- **Telemetry**: `exportDbmlRich`, `exportAll`, `importDbml`, `importDbmlLayout`, `importDbmlCancelled`, `importDbmlInvalid` (the user's file is not valid DBML) and the error `importDbmlFailed`. Nothing else, and never a name or path. Open Example Diagram runs the same flow with `source: 'example'`: a finished run counts `exampleDiagram` instead of `importDbml` (retries included, since `source` travels in `deps`) and a cancel counts nothing; only `importDbmlFailed` is shared.

## Tests

- Goldens: `packages/core/test/fixtures/golden/<fixture>.rich.dbml` and `<fixture>.dbdiagram` for every core fixture, plus `rich-features` (every mapping row). Regenerate with `UPDATE_GOLDEN=1` only for an intended change; a new golden file name must also go into `EXPECTED_FILES` in `test/unit/displayDomainGolden.test.ts`, or `UPDATE_GOLDEN=1` there deletes it.
- Import fixtures: `test/fixtures/dbml/` (`foreign/` written from dbdiagram's public syntax docs, `erd-studio/` a rich export with its layout, `dbdiagram-pull/` the pulled pair).
- `test/unit/dbmlRoundTrip.test.ts`: export → read → plan → write with the real `TableLibraryService` → load, compared field by field over every core fixture and the `dbt-project` subject areas, in v5 and v6 projects, with relationships in the library or the subject area file; a second export must equal the first. **Every allowed difference is listed, with its reason, in that file's header** — add one there, not in an assertion's tolerance.

## Adding a property

1. Add the name to `dbmlRichProperties.ts` (names already there are a contract: never rename one).
2. Write it in `exportDbmlRich.ts` and read it in `dbmlImport.ts`, both through the constant.
3. Cover it in `rich-features` and regenerate the goldens; the round-trip test must pass without a new exception.
4. A core change ships to npm and the Confluence app on merge: keep it additive (a package PATCH), with a line in `packages/core/CHANGELOG.md`.
