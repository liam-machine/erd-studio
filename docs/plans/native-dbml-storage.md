# ERD Studio 2.0: native DBML storage (implementation spec)

Branch `feat/native-dbml-storage` (from `origin/develop` at cf0113b). This is the plan every stage works from. It names the decisions (§0) and the format, which is normative (§2). The stages are in §10. Read the root `CLAUDE.md`, `packages/CLAUDE.md` and the `docs/dev/*.md` it points at before you start a stage. Where this spec and those files disagree about **storage**, this spec wins, and stage S9 rewrites those files to match it. On anything else, those files win.

The words *must*, *never* and *always* are normative. "Diagram" and "subject area" mean the same thing. "Table" and "model" mean the same thing (`SemanticTable`). Paths are relative to the semantic dir (`erdStudio.semanticDir`, default `.erd-studio`) unless they start with `src/`, `packages/`, `test/`, `docs/` or `mcp-server/`.

Parser facts verified for this spec, all under `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0 unless a version is named:

- Duplicate Ref names are accepted, and quoted Ref names with spaces are accepted (`Ref "ship date": …`).
- A quoted Note name holding a UUID is accepted, and so is an empty Note body `''`.
- A Project with `erd_*` keys and `database_type` is accepted, and every value reads back as a string. A quoted Project name with `\"` is accepted.
- `use` paths with and without `.dbml` both resolve.
- Two `use` lines of the same file in one diagram are accepted.
- A diagram that imports two relationships files that both `use` the same tables is accepted.
- The same Ref in two imported files fails the importer with `[5001] References with same endpoints exist`.
- A wrong-case table name in a Ref fails with `[4000]`. So does an inline `[ref: > other.col]` in a table file without `use`.
- **10.3.1 silently drops the tables of an imported file whose path contains a space** (9.1.1 and 11.0.0 keep them), and reports no error while doing it (`tables: []`, zero diagnostics). ERD Studio runs the pinned 11.0.0, which is not affected; §4.1 and §4.3 still compile under a fixed virtual path, never the real one, so reads do not depend on where the project lives and the tests that feed 10.3.1 (the `dbml-parse-v10` alias) see the same thing.
- Replacing every `use` declaration's span with spaces (offsets kept) makes a diagram compile on its own, and `rawDb` then gives the Project (name, Note, custom keys) and the Notes (name, content, `metadata.linked_table`). **11.0.0 gives Table, column and Note custom values as `{value, type, token}`** (`type` is `'string'`, `'number'`, `'bool'` or `'color'`); 9.1.1 and 10.3.1 give a plain string. **Project custom keys are plain strings in all three**, 11.0.0 included. A Note's colour is not in `rawDb.notes[i].headerColor`; read it as `color` (a plain string in all three; the import already does, `dbmlImportParse.ts`) or from the attribute list.
- **`filepath` objects differ**: a token's or diagnostic's `filepath` serialises as `{path}` in 9.1.1 and 10.3.1 and as `{root, segments}` in 11.0.0. `Filepath#absolute` returns the absolute path string in all three, so code reads a file path only through `.absolute`, never through `.path` or the JSON shape. `Filepath.from`, `MemoryProjectLayout`, `Compiler`, `DEFAULT_ENTRY` (`/main.dbml`) and `DBMLDiagnosticsProvider` are exported by all three with the same use.
- In all three (same kinds, fields and offsets, verified), a `use` declaration is an AST node `kind: '<use-declaration>'` in `ast.body`, with `importPath.value`, `specifiers.kind` (`<wildcard>` or a list) and `start`/`end`/`fullStart`/`fullEnd`. Every other top-level construct is an `<element-declaration>` with `type.value` (`Table`, `Ref`, `Project`, `Note`, …), `name`, `attributeList`, `body` and offsets.
- **`fullStart` includes the comment lines above a node** (its leading trivia). For the first element of a file it is 0, so it covers the file's header comment. `start` is the first token of the node itself; `fullEnd` includes the trailing same-line comment and the line break. Every "delete a node" rule in this spec therefore cuts from the line start of `start` to `fullEnd`.
- **A leading byte-order mark (U+FEFF) fails `[1000]`** in all three parsers. VS Code keeps the mark out of a document's text but not off disk.
- **`use *` also imports `Enum`s.** Two table files that each declare `Enum status` make every file that `use *`s both fail `[3003] Enum 'status' already exists`. **`use { table x } from '…'` imports only the table** and avoids it (verified in all three parsers, with bare, quoted, keyword and schema-qualified names). A column typed with an Enum the importer did not import still compiles, as a plain type name.
- **Constructs that name tables fail inside a diagram whose `use` lines are blanked**: a `Ref` or `TableGroup` gives `[4000]`. A repeated Note name gives `[3003]` and a second `Project` `[3058]`/`[3060]`. Each makes `rawDb` undefined.
- **Unquoted custom values.** 11.0.0 accepts a number or boolean literal on a Table, column or Note (`natural_key: true`, `natural_key: TRUE`, `scd_type: 2`, `w: 1.50`, `neg: -2`, `e: 1e3`) and reads it as `{value: <number|boolean>, type: 'number'|'bool'}`, so `007` reads as `7`, `1.50` as `1.5` and `1e3` as `1000`; the token spans the whole `key: value` attribute, so the literal's own text is recoverable. 9.1.1 and 10.3.1 reject every one of them and fail the whole file, including every diagram that imports it. **All three** reject an unquoted word or phrase (`role: fact`, `role: conformed-dim`, `grain: one row`) and `null`. **Project** custom keys must be quoted strings in all three (`erd_schema_version: 7` fails). The writer always quotes (§2.2).
- **Error codes for an unquoted value depend on the parser.** 10.3.1 and 11.0.0 share the numbering: `[3025]` column setting, `[3075]` table setting, `[3051]` Note setting, `[3063]` Project custom key (11.0.0's message adds "a number literal, or a boolean literal"). 9.1.1 numbers them `[3025]`, `[3073]`, `[3049]` and `[3061]`, and in 10.3.1 and 11.0.0 `[3073]` means a duplicate TablePartial injection and `[3061]` an invalid Project field. Code-keyed rules (the "quote the value" hint) therefore use the pinned 11.0.0 numbering only.
- **Nullable Ref marks** `a.x >? b.id`, `b.id ?- a.x` and `a.x <>? b.y` parse in all three parsers. The `?` marks the end across from it as possibly null (`>?`: the FK may be null).
- **The 10.3.1 space bug is about any directory in the absolute path**, not only the file name: the same project under `/My Projects/repo` compiles with no errors and `tables: []`.
- **VS Code's `workspace.applyEdit` is all-or-nothing only for text edits.** "A workspace edit with resource creations or deletions aborts the operation … when a single edit fails", and keeps what already ran (`node_modules/@types/vscode/index.d.ts:13313-13315`). §5.3 and §6.2 reconcile after a `false`.

---

## 0. Decisions

| # | Decision | Why (one line) |
|---|---|---|
| D1 | Tables go in `tables/[<folder>/]<name>.dbml` (one Table each, self-contained). Relationships go in `tables/[<folder>/]_relationships.dbml`, one per library folder. Diagrams go in `<layer>/<name>.dbml`, with the layout in `<layer>/<name>.dbdiagram` beside it. `layers.json` and `templates/*.json` stay JSON. Only the name `_relationships` is reserved, and only for new `.dbml` tables (§2.1). | This keeps the `.erd-studio` shape. The relationships file sits inside `tables/`, so it is never mistaken for a layer folder (§2.3), and reserving one name (not every `_` stem) keeps `_x` tables and diagrams that dbt and 1.x allow. |
| D2 | Table names are **unqualified**: `Table fct_order [schema: 'gold']`. The writer names a new file exactly as the Table. The reader compares the file stem and the declared name **case-insensitively**; the table's identity is the **declared** spelling, and paths always come from the directory listing's real file name (never from the name being looked up). | Library names are unique project-wide, so qualifying adds nothing. A schema edit stays an edit to one file. A case-only rename that `core.ignorecase` does not apply on macOS/Windows must not make a table unreadable on those machines only; `doctor` warns when stem and name differ in case. |
| D3 | A relationship belongs to its **foreign-key table** (the canonical `fromModel`, as today), and it is stored as one Ref line in the relationships file of **that table's folder**. The reader canonicalises every Ref and attaches it to its owner **from any relationships file it reads**; a Ref found in another folder's file is "misplaced" (a warning), and the next write that changes the owner's relationships, name or folder moves it home in the same edit. | `planRelationshipWrite` keeps choosing an owner table. Only the codec maps the owner to a file. A `git mv` or a hand-placed Ref must never make a relationship vanish or be written twice (`[5001]`). |
| D4 | A diagram's members are its **table `use` lines**, in order: the member is the **stem** of any `use` path whose stem passes `isSafeTableName` and is not `_relationships`. Members are resolved **by name**, in the shared candidate order (§3.4). A diagram's `use` lines for relationships files are output the writer maintains for other DBML tools; they are never read for meaning. | One answer in every host. A missing, dangling or wrongly spelled `use` path degrades to a placeholder or a `doctor` warning, never to a vanished member or a dead diagram. No path in the repo is ever trusted for reads. |
| D5 | DBML diagrams hold **no** Refs. Every relationship edit on a DBML diagram uses `home = 'library'`. | Liam's layout. The library rule "drawn when both ends are in the diagram" (`domain.ts:796`) is unchanged. |
| D6 | Reading is **tolerant and per file**: each table file is parsed on its own (inline `ref:` settings, `use` and `Ref` lines blanked first), each relationships file is read Ref by Ref from the AST, and diagrams are read with every `use`, `Table`, `Ref`, `TableGroup`, `Enum`, `TablePartial`, `Metadata`, repeated `Note` and repeated `Project` span blanked. Display never uses a multi-file `rawDb`. A leading BOM is stripped before parsing. | `rawDb` is all-or-nothing. One deleted table file or one hand-written construct must not blank every diagram and relationship. |
| D7 | Writing is **splicing at parser node offsets**. A no-op write is byte-identical. A file that does not parse is **refused, never regenerated**. A derived block (`use` lines, `meta_json`, the PK form) is touched only when its inputs changed in this edit. A BOM the file had is kept. | The CLAUDE.md in-place rule, carried over to DBML. |
| D8 | `CURRENT_SCHEMA_VERSION` = 7 (the newest version core reads, in any format). New `DBML_SCHEMA_VERSION` = 7 is written as `erd_schema_version: '7'` on a diagram's Project. New `CURRENT_JSON_SCHEMA_VERSION` = 6 is the JSON ceiling, with the **same** refusal text. The in-memory v5 object a DBML diagram is read into carries `schemaVersion: WRITTEN_SCHEMA_VERSION` (5); the DBML version travels **beside** it (`DbmlSubjectAreaReading.schemaVersion`, `ParsedSubjectArea.dbmlSchemaVersion`) and is applied only to the Unified and Display `schemaVersion`. | A JSON file that declares 7 is still refused, exactly as today, and goldens do not churn. `detectSubjectAreaFormat`, `mixesTableNaming` and `validateSubjectAreaDocument` keep seeing a plain v5 document at every call site (`SemanticEditorProvider.ts:1860`, `:2633`, `:3011`, `:5303`, `domainService`, `diff.ts`, `doctor.ts`, `moveRelationshipsToLibrary.ts`) instead of a `hybrid` one. |
| D9 | One storage detector, `detectProjectStorage(evidence): 'yaml' \| 'dbml' \| 'mixed'`, sits in core beside `detectProjectNaming`, with its own type. An empty project answers `'dbml'`. **Only library evidence** (table and relationships files, and an existing `logical-models/` folder) decides it; a `.dbml` diagram on its own never turns a YAML project into DBML. `'dbml'` and `'mixed'` write DBML for **new** files, except when `tables/` is a layer. The empty-project default reaches the host's create paths in one stage (S6). | It is the single answer shared by the canvas, commands, the offer, the context keys and `doctor`. Keeping it out of `ProjectNaming` stops existing exhaustive switches from breaking. A stray export in a layer folder must not make a team project write files 1.x teammates cannot read. |
| D10 | One file classifier, `classifySemanticFile()`, lives in core (parser-free). Every host site that asks "is this a diagram, table, relationships file or layout?" calls it. | It replaces three ad-hoc `.json` checks that would otherwise each need the `tables/` exclusion. |
| D11 | Add the custom-editor selector `**/.erd-studio/*/*.dbml` at priority `default`. A `file:` `.dbml` the classifier says is not a diagram is **rerouted** to the text editor inside `resolveCustomTextEditor`; other schemes (SCM diff, merge editor) are never rerouted (§5.9). The Table Library opens `.dbml` with `openWith 'default'`. | A glob cannot exclude `tables/x.dbml` or `tables/_relationships.dbml`. The fallback is in §5.9. |
| D12 | All parser-dependent code lives under `packages/core/src/dbml/` and is exported as the subpath **`@erd-studio/core/dbml`**. The main entry stays parser-free. `loadDisplaySubjectArea` gains an optional `dbml` reader option. The subpath exports only APIs typed with ERD Studio's own types; the parser wrappers stay internal. | The webview and renderer never pay for the 560 KB parser (it has no `sideEffects:false`; an unused import still costs about 169 KB). The renderer's `editor/store/sizing` subpaths are the precedent. `@dbml/parse`'s own `.d.ts` imports the uninstalled `monaco-editor-core`, so a leaked type fails strict consumers. |
| D13 | `@dbml/parse` becomes an **exact `"11.0.0"` runtime dependency** of core and is external in `packages/core/build.mjs`, which builds both entries in **one** esbuild call with `splitting: true` so the main entry and the subpath share module instances (the four error classes stay one class each). The root `@dbml/parse` pin moves from 10.3.1 to **11.0.0 in the same stage (S2)**, so the extension, CLI and MCP bundles hold one copy, and Import DBML reads with 11.0.0 too (§4.1 "Parser pin"). The writer still quotes every value, so 9.x and 10.x tools read every file ERD Studio writes; the reader also accepts 11.0's unquoted numbers and booleans. Tests keep reading with 9.1.1, 10.3.1 and 11.0.0. core and renderer **stay at 0.4.0**: 0.4.0 is unpublished (npm and `main` are at 0.3.0), so 0.3.0 → 0.4.0 is the pinned MINOR. The breaks go into the existing 0.4.0 changelog sections. | Liam chose 11.0.0 (Appendix, question 1): it reads the `natural_key: true` / `scd_type: 2` that assistants write naturally and has no space-in-path bug. No version is skipped. The Confluence app has zero users. Two bundled copies of `domain.ts` would break `instanceof` on the public error classes. |
| D14 | The extension changelog heading becomes `## Unreleased — 2.0.0` (Liam asked). The root `package.json` version is never edited. | `releasing.md` and `scripts/release.mjs:110`. |
| D15 | A relationships file is **never deleted automatically**. Once it has no Refs left, it keeps its header comment and no `use` lines. | Diagrams `use` it. Deleting it would break them with 4001 for DBML tools. |
| D16 | **Delete Table** in a DBML project cascades in one WorkspaceEdit. It removes the file, the Refs the table owns, other owners' Refs to it, and every `use` line that names it, in diagrams and in relationships files. It also prunes positions and sticky links in the diagrams. | Dangling `use` and Ref lines break whole files for other DBML tools. Reads stay tolerant of external deletes (D6). |
| D17 | A table file has no `use` lines. A relationships file has a `use` line for every table its Refs name. A diagram has `use` lines for its member tables and for their folders' relationships files. The writer writes **selective** lines, `use { table <declared reference> } from '<relative path with .dbml>'`, for tables, and `use * from '…'` only for relationships files (which declare nothing). The reader also accepts `use * from …` for tables and a path without the extension. | `use` is not transitive (verified). `use *` would also import Enums, so two tables declaring the same Enum name would break every file importing both (`[3003]`). A rename regenerates the whole line anyway. Enums do not travel into diagrams; the column type still reads as its name. Liam confirmed selective lines (Appendix, question 3). |
| D18 | The writer marks the **FK end as possibly null on every Ref it writes**, in a form that depends on no other file: `from.fc >? to.tc`, `to.tc ?- from.fc`, `from.fc <>? to.tc`. The reader ignores `?` for cardinality and uses it only for a one-to-one's direction (§2.3). A Ref already in the file keeps its marks (or their absence) byte for byte unless the unit changes. | ERD Studio records no nullability, and DBML 9+ reads a bare `>` as NOT NULL (`docs/dev/dbml.md`, Rules), which would claim a NOT NULL foreign key to every DBML or SQL tool. The export's per-key `?` rule needs primary keys from other files; a constant FK-side mark does not. Liam confirmed (Appendix, question 2). |
| D19 | Import DBML into a DBML project reuses `planDbmlImport`. DBML-only settings stay in `meta.dbml`, written as `meta_json`, exactly as in a YAML project. Hoisting them to native DBML settings is a follow-up, not 2.0. | This is lossless with no new mapping. The dbdiagram parity work comes later (Liam). |
| D20 | In a mixed project a DBML diagram can only contain **DBML** tables, and a DBML-owned Ref can only name **DBML** tables. Adding a YAML table to a DBML diagram, and adding, editing or renaming a relationship from a DBML owner to a YAML table, are refused: "Convert the project to DBML first (ERD Studio: Convert Project to DBML)". An existing DBML-diagram member that resolves to a `.yml` keeps its `use` line bytes and shows a warning. A JSON diagram can contain both kinds, because it references tables by name, and a YAML owner may still name a DBML table (its yml holds the relationship). | A `use` line cannot point at a `.yml`, and a Ref with no `use` target fails `[4000]` and breaks its whole relationships file in every DBML tool. Mixed is a transitional state. |
| D21 | Telemetry is append-only on both sides. New error codes and features are appended to `src/services/telemetryPayload.ts` **and** `telemetry/src/index.js` and documented in `telemetry.json`. `schemaFormats` is **not** changed: a DBML canvas counts as `'v5'`, plus the feature `dbmlProject`. | The `Record<TableLoadErrorKind,…>` forces new codes. Mapping DBML failures onto YAML codes would corrupt the existing series. The Worker drops unknown keys, so slipping the Worker deploy is harmless. A new `schemaFormats` value would make the deployed Worker reject whole heartbeats. |
| D22 | **Convert Project to DBML** is a pure planner, `planDbmlConversion`, with a describer shared by the modal and `doctor`, one WorkspaceEdit of creates, replaces and deletes, and refusals instead of guesses. It finishes mixed and half-converted projects (a target that already holds exactly the planned bytes is a resume, not a refusal). It moves relationships held in diagram files into the library. YAML comments and unknown keys are carried as `//` comment blocks and listed in the notes. Anything it cannot write as valid DBML (a dangling Ref, a double-stored link, a duplicate Note id) is handled by a named rule and a note, and a self-check failure is a named refusal. | It follows the `namingMigration` skeleton. Nothing the user wrote disappears without being named. |
| D23 | Every WorkspaceEdit that creates or deletes files is applied by **one helper, `applyFileWrites`** (§5.3): creates first (relationships files before table files), then replaces, then deletes. When `applyEdit` returns `false`, the helper reconciles: it deletes every planned create whose bytes are on disk as planned, re-creates every deleted file from the text it read, and puts every replaced document back with a text-only edit. | VS Code keeps the steps that ran before a failing resource step (verified in its API docs), and `migrateNaming.ts:383-385` wrongly assumes "Nothing landed". Ordering creates first means a half-applied edit never leaves a table without its relationships file. |
| D24 | **One storage-equivalence comparator**, `normaliseForStorageEquivalence(display)` in core (`packages/core/src/storageEquivalence.ts`, parser-free), applies exactly the §2.8 normalisations. The DBML-twin goldens, Law 3, Convert's self-check and `scripts/e2e-dbml.mjs` all compare through it. | Four places would otherwise each invent their own tolerance and disagree. |
| D25 | **`Metadata` blocks** (`Metadata Table t { … }`, `Metadata Column t.c { … }`, DBML 9.1+) are never written by ERD Studio and never used as sidecar files, but a hand-written table file may contain them. The reader needs nothing new (rawDb already merges block values over inline ones). The **writer edits a property where it is set**: if a property being changed is set by a `Metadata` block in the same file, the splice edits (or removes) that block entry in place instead of the inline setting, so the edit sticks. Built-ins a block can set (`note`, `headercolor`) follow the same rule. A block whose target is missing gives the precise load error of §4.7. | A block value silently overrides an inline one (precedence: inline < imported-file blocks < current-file blocks, later wins), so an inline-only splice would look like an edit that does not stick. Liam, 2026-10-28; sidecar metadata files rejected (cross-file all-or-nothing breakage, two homes for one value, invisible to dbdiagram/dbdocs). |

---

## 1. Goals and non-goals

### Goals

1. A new ERD Studio project stores its logical model as DBML, an open format. Tables, relationships and diagrams are `.dbml` files that DBML parsers 9.1 and 11+ read as a multi-file project (10.x too, except that it drops imported tables when any folder in the project's path contains a space; `doctor` warns about such a path), and their positions are in a dbdiagram-style `.dbdiagram` JSON file.
2. Existing projects keep loading **and** stay fully editable, whatever their shape:
   - schema v4 (with the v4 → v5 prompt), v5 or v6;
   - a flat or foldered library, in `logical-models/` or `tables/`;
   - relationships in the library, in diagram files, or in both.
3. **Convert Project to DBML** migrates a project in one step:
   - a dry run first;
   - refusals rather than guesses;
   - one WorkspaceEdit;
   - Edit > Undo while VS Code is open (or source control);
   - a preview in `erd-studio doctor`;
   - the editor offers it, as a prompt only.
4. Every canvas edit still goes through `applySubjectAreaEdit` / `applyTableEdit`: one WorkspaceEdit, one save pass, one undo step.
5. `planRelationshipWrite` stays the only relationship planner. In memory, relationships still hang off the FK-side `SemanticTable`.
6. DBML writes are byte-preserving:
   - comments, formatting and constructs ERD Studio does not understand survive;
   - a no-op save is byte-identical;
   - every file the writer creates, and every edit of a file that already parsed in all three, parses with no errors in 9.1.1, 10.3.1 and 11.0.0 (ERD Studio runs 11.0.0 but never writes 11.0-only syntax; a typed value someone else wrote is kept as written and flagged by `doctor`, §2.2).
7. The CLI, the MCP server, the AI harness, the docs and the Marketplace copy describe DBML as the storage. The extension ships as 2.0.0.

### Non-goals

- **dbdiagram parity.** Pushing the split multi-file project straight to dbdiagram.io is out of scope. So is exact `.dbdiagram` sticky-note layout parity, and hoisting `meta.dbml` to native settings (D19). The single-file Export (`dbml-rich` + `.dbdiagram`) stays the route to dbdiagram.io and does not change.
- **The physical stage.** It is derived at runtime and never persisted. Nothing in it changes.
- **The Confluence app** (private repo `liam-machine/erd-studio-pro`) is not touched. It needs these follow-ups, recorded in `packages/core/CHANGELOG.md` and the PR body:
  - bump `@erd-studio/core` and `@erd-studio/renderer` to 0.4.0;
  - pass `dbml: dbmlStorageReader` (from `@erd-studio/core/dbml`) to `loadDisplaySubjectArea`;
  - let its bundler include `@dbml/parse`;
  - bump its cache key.

  A Confluence build on core 0.3.0 given a `.dbml` path throws `SubjectAreaFileError('invalid-json')` with `transient: true`. Say this in the core changelog as a breaking note.
- **A DBML language contribution** (syntax highlighting) or a JSON Schema for `.dbml`. `.dbml` files have no schema. `layers.json`, `templates/*.json` and the legacy `.json` / `.yml` files keep theirs.
- **Writing YAML or JSON in a DBML project.** Nothing writes `.yml` or a `.json` diagram once storage is `dbml`.

---

## 2. On-disk format (normative)

### 2.1 Layout

```
.erd-studio/
├── layers.json                          JSON, unchanged
├── templates/*.json                     JSON, unchanged
├── tables/                              the table library (never a layer in a DBML project)
│   ├── dim_date.dbml                    one Table per file, top level
│   ├── _relationships.dbml              Refs owned by top-level tables (only if any)
│   └── gold/                            optional folder, one level (any non-dot name, as listFoldersOf reads it)
│       ├── dim_customer.dbml
│       ├── dim_region.dbml
│       ├── customer_profile.dbml
│       ├── fct_order.dbml
│       ├── bridge_empty.dbml            zero-column table → placeholder column
│       └── _relationships.dbml          Refs owned by tables in tables/gold/
└── gold/                                a layer folder
    ├── sales.dbml                       diagram
    └── sales.dbdiagram                  its layout (positions, sticky-note boxes); absent until something is placed
```

Path rules:

- **Table file**: `tables/<name>.dbml` or `tables/<folder>/<name>.dbml`. A new file is named exactly as the table, and `<folder>` follows the library's existing folder rules (`groupsByFolder`, `newTablePath`). A library folder is any one-level directory whose name does not start with `.`, the rule `listFoldersOf` (`logicalModelService.ts:744-753`) already applies (`Finance` and `SAP FI` included). `TABLE_FOLDER_PATTERN` stays the rule for folders ERD Studio **creates**, never for folders it reads.
- **Relationships file**: `tables/_relationships.dbml` or `tables/<folder>/_relationships.dbml`. The constant is `DBML_RELATIONSHIPS_FILE_NAME = '_relationships.dbml'`.

  The name `_relationships` (in any case) is reserved **only where a `.dbml` table would be created in `tables/`**: Add, Rename, Draw from dbt, Add Existing, Import and Convert refuse it there with "‘_relationships’ is the name of the relationships file; choose another table name." It is checked by the new `validateNewDbmlTableName` on create paths only, never by `validateTableNameSafety` (which also checks messages about **existing** tables, `payloadValidation.ts:642,687`). An existing YAML table `logical-models/_relationships.yml` or `tables/_relationships.yml` stays listed and editable. Convert refuses a project holding one, naming it.

  The file is never mistaken for a layer, a diagram or a table:
  - it is inside `tables/`, which is never a layer in a DBML project (§3.3);
  - `classifySemanticFile` (§3.5) names it by its exact reserved stem.
- **Diagram**: `<layer>/<name>.dbml` where `<layer>` is not in `NON_SUBJECT_AREA_DIRS` and not the table library. Any stem is a diagram, `_x` included; only a stem equal to `_relationships` (in any case) is `other`. A file whose first line starts with the export header `ERD_STUDIO_DBML_HEADER_PREFIX` is `other` where the caller can read it (§3.5).
- **Layout**: `<layer>/<name>.dbdiagram` beside its diagram, named `layoutFilePathOf(diagramPath)`.
- **BOM**: every reader strips a leading U+FEFF before parsing (all three parsers reject it, `[1000]`). Host writes go through the document text, which never holds the mark (VS Code writes it back on save). The fs paths (§5.1) put it back when the file had one. Every splice offset is computed on the text without the mark.

### 2.2 Table file

**Grammar.** A table file is:

- optional leading comments;
- **exactly one** `Table`;
- any number of `Enum` declarations (self-contained column types);
- comments.

Two kinds of deviation, handled differently:

- **Readable with a warning; writes refused until fixed.** A `use` line, a `Ref` line, or a column `[ref: …]` setting (the most common hand-written DBML foreign key). The reader blanks their spans before compiling (offsets kept): a `ref:` setting together with its separating comma, and the `[ … ]` brackets as well when nothing else is left in them. The table loads, with the problem `inlineRefInTableFile` / `useInTableFile` / `refInTableFile`. Its message carries the exact line to add instead, for example "Move this to tables/gold/_relationships.dbml as `Ref: fct_order.customer_key >? dim_customer.customer_key`". The Ref is **not** attached as a relationship. Every write to the file is refused with that message until the line is removed.
- **A `dbmlStructure` load error** (§4.7), and the writer refuses the file: `Project`, `TableGroup`, a top-level `Note`, `TablePartial`, `Records`, `DiagramView`, no `Table` or a second `Table`, or a declared name (its table part, with any schema qualifier removed) that differs from the stem **other than in case**.

The Table **must** have at least one column (`[3018]`), which is why the placeholder exists.

**Names and aliases.** The stem and the declared name are compared case-insensitively (D2). The table's in-memory `name` is the declared spelling. A hand-written DBML alias (`Table fct_order as FO`) is read and kept; Refs may use it (§2.4). The writer never writes `as`.

**Example: `tables/gold/fct_order.dbml`**

```dbml
// Order lines from the shop. Hand-written comments like this one survive every save.
Table fct_order [
  schema: 'gold',
  role: 'transaction-fact',
  grain: 'One row per order line',
  alias: 'orders',
  rationale_purpose: 'Revenue reporting by day, customer and region',
  rationale_measures: 'amount is additive',
  meta_owner: 'sales-data',
  meta_json: '{"pii":false,"tags":["finance"]}'
] {
  order_line_id BIGINT [pk, note: 'Line id from the shop']
  customer_key INT [foreign_key: 'true']
  order_date_key INT
  ship_date_key INT
  region_code VARCHAR
  country_code VARCHAR
  amount "DECIMAL(18,2)" [additive_type: 'additive', note: 'Line total']
  order_number VARCHAR [natural_key: 'true'] // the business key
  loaded_at timestamp [not null, default: `now()`]   // DBML-only settings: kept, never read
  Note: 'Order lines'
}
```

**Example: `tables/gold/dim_customer.dbml`** (composite key, SCD and a self-reference)

```dbml
Table dim_customer [schema: 'gold', role: 'conformed-dim'] {
  customer_key INT [note: 'Surrogate key']
  valid_from DATE [scd_type: '2']
  customer_id VARCHAR [natural_key: 'true']
  parent_customer_key INT
  segment VARCHAR [scd_type: '1']
  indexes {
    (customer_key, valid_from) [pk]
  }
}
```

**Example: `tables/gold/bridge_empty.dbml`** (zero columns)

```dbml
Table bridge_empty {
  _erd_no_columns unknown [erd_placeholder: 'true', note: 'ERD Studio: this table has no columns yet, and DBML needs one']
}
```

**Field mapping.** `packages/core/src/dbmlRichProperties.ts` is the **one** property-name table. Storage adds no new table or column property names.

| `SemanticTable` / `ColumnDef` | DBML (written) | Read also accepts |
|---|---|---|
| `name` | `Table <ident(name)>`. The file stem equals `name` exactly. | `Table <schema>.<name>` (schema read from the qualifier, §2.2 schema rule) |
| `schema` | `schema: '<schema>'` table property when set; absent when unset | the qualifier |
| `description` | body `Note: '<text>'`, the last element of the body | header setting `[note: '…']` (the writer edits it where it is) |
| `modelRole` | `role` | `erd_role` |
| `grain` | `grain` | `erd_grain` |
| `alias` | `alias` (custom property; DBML's own `as` alias is never written) | `erd_alias` |
| `rationale.<key>` | `rationale_<snake_case>` (`rationaleProperty`) | `erd_rationale_…` |
| `meta` | `meta_<key>: '<text>'` for a string value under `/^[a-z_][a-z0-9_]*$/` (not `json`); every other entry goes into **one** `meta_json: '<JSON of exactly those entries>'` | `erd_meta_…` |
| column `name` | `<ident(name)>` | quoted names |
| column `dataType` | `columnType(dataType)`: bare when a plain identifier, else `"…"`; empty → `""` | any DBML type. The read value is `rawDb` `type.type_name` (args included, quotes stripped). |
| `isPrimaryKey` | single PK → column `pk`; two or more → `indexes { (a, b) [pk] }` | `primary key` flag |
| `description` (column) | `note: '<text>'` | |
| `isForeignKey` | `foreign_key: 'true'`, stored as the flag says. **Never derived from Refs** (unlike the export). | `erd_foreign_key` |
| `isNaturalKey` | `natural_key: 'true'` | unquoted `true` (DBML 11, with the `unquotedValue` warning; the same for every flag) |
| `scdType` | `scd_type: '0'\|'1'\|'2'` | unquoted `0`, `1`, `2` (DBML 11, with the warning) |
| `additiveType` | `additive_type: '<value>'` | |
| column `meta` | as table meta | |
| no columns | the placeholder column `_erd_no_columns unknown [erd_placeholder: 'true', note: …]` | dropped on read only when it carries `erd_placeholder` |

**Writing rules** (shared with the export through the new `packages/core/src/dbmlText.ts`; §4.2):

- **Rule one, also the first table rule in `SCHEMA_CONTENT`: quote every custom value, even `'true'` and numbers.** ERD Studio (on 11.0.0) reads an unquoted `natural_key: true` or `scd_type: 2`, but 9.x and 10.x fail the whole table with `[3025]`, and every diagram that imports it, so a file with one is not portable. An unquoted word or phrase (`role: fact`, `grain: one row`) fails in every parser, ERD Studio's included; the reader maps 11.0.0's `[3025]` (column) and `[3075]` (table) to the hint "Quote the value, as in `grain: 'One row per order line'`" (§4.3, §4.7). The hint no longer uses `natural_key: 'true'` as its example, because under 11.0.0 an unquoted `true` is not an error.
- Every custom-property value is a **quoted string**. A one-line value is single-quoted and a value with a line break is triple-quoted, both escaping `\` and `'`. Never write an unquoted typed value: 11.0-only syntax breaks 9.x and 10.x.
- **Typed values on read** (Table, column and Note settings only; Project keys are always strings). The reader takes an 11.0.0 `number` or `bool` value as the **literal's own text** (the attribute token's text after its `:`, trimmed), not `String(value)`, so `meta_owner: 007` reads `'007'` and `w: 1.50` reads `'1.50'`; flags compare case-insensitively with `'true'` (`isTrue`), so `true` and `TRUE` set a flag and `false` leaves it unset; `scd_type: 2` reads as 2 through the same `yamlToTable` normalisation as `'2'`. Each typed value is a warning `unquotedValue` on the table ("`natural_key: true` reads only in DBML 11+; quote it, as in `natural_key: 'true'`, so DBML 9 and 10 tools can read the file") and a `doctor` warning (§7.1). The writer never refuses such a file: a typed value it does not change stays byte for byte (Law 1), and a value it changes or adds is written quoted. It never requotes a value it was not asked to change (D7).
- A flag is written as `'true'` only when it is set. Unsetting it removes the property.
- Names are bare when they are a plain identifier and not a DBML keyword, else double-quoted with `\"` and `\\` escapes. These are the `ident()` and `KEYWORDS` of `exportDbmlRich.ts`, moved to `dbmlText.ts`.
- Notes and descriptions go through `noteText()`: leading whitespace is dropped (§2.8).
- A new file is laid out as the rich export's `tableBlock` does, minus the Ref-derived `unique` and `foreign_key` additions and with an unqualified name. Settings go inline when there is one, else as a multi-line list. There is one column per line, an `indexes` block only for a composite PK, the `Note` last, two-space indents and `\n` line endings.
- When editing an existing file, take the indent from the first column line and the EOL from the file (`\r\n` if it holds any).

**Schema rule.** A table written by ERD Studio carries its schema as a property. A hand-written `Table gold.x` is read with schema `gold`. A schema edit on such a table is **refused** with: "tables/…/x.dbml names its schema in the Table name (`Table gold.x`). Change it there, or remove the qualifier and use `[schema: 'gold']`." Ref ends and `use { table … }` specifiers in other files spell the table as declared (its **declared reference**, `gold.x`: §4.5 `resolve`), so changing the qualifier would be a cross-file rename.

**Settings ERD Studio does not model** (`not null`, `unique`, `increment`, `default`, `headercolor`, `check`, `indexes` other than the PK, enums, comments, custom properties it does not know) are never read into memory and are preserved byte for byte by splicing. An `Enum` used as a column type reads as the type name.

### 2.3 Relationships file

One file per library folder holds every Ref whose **owner** (§2.4) is a DBML table in that folder.

**Example: `tables/gold/_relationships.dbml`**

```dbml
// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_date } from '../dim_date.dbml'
use { table customer_profile } from './customer_profile.dbml'
use { table dim_customer } from './dim_customer.dbml'
use { table dim_region } from './dim_region.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: dim_customer.customer_key ?- customer_profile.customer_key
Ref "parent": dim_customer.parent_customer_key >? dim_customer.customer_key
Ref: fct_order.customer_key >? dim_customer.customer_key
Ref "order date": fct_order.order_date_key >? dim_date.date_key
Ref "ship date": fct_order.ship_date_key >? dim_date.date_key
Ref: fct_order.(region_code, country_code) >? dim_region.(region_code, country_code)
```

(The one-to-one above is owned by `customer_profile`, its FK and second end, which also lives in `gold/`.)

**Grammar:**

- **Header.** The first line is the comment `DBML_RELATIONSHIPS_FILE_HEADER` (the text above). It is written only when the writer creates the file, and never required on read.
- **`use` lines.** There is one `use { table <declared reference> } from '<posix path relative to this file, with .dbml>'` for **every table named by any Ref in the file**, sorted by path string (byte order) in one block after the header (D17). This is required: `use` is not transitive, and without it the file fails `[4000]` and breaks every diagram that imports it. The reader accepts `use *` too.
- **Ref lines.** `Ref[ <ident(role)>]: <end> <op> <end>[ <settings as found>]`, one per relationship unit (a composite is one unit), sorted (§4.5). Each end is spelled `<declared reference>.col` or `<declared reference>.(c1, c2)`, using the table's declared spelling (the library's real case, with its schema qualifier if it has one) and each column's **real spelling** from its table file, with `ident()` for every name.

**Operators.** The writer never writes `<`. It always marks the FK end with `?` (D18). The reader accepts every form. A `?` never changes the cardinality; it only decides a one-to-one's direction (below).

| Cardinality (canonical, `from` = FK side) | Written | Read back |
|---|---|---|
| many-to-one | `Ref: from.fc >? to.tc` | `>`: from = left |
| one-to-one | `Ref: to.tc ?- from.fc` (the **FK is the second end**, as DBML, its SQL export and `exportDbmlRich`/`dbmlImport` read it; the `?` also marks it) | `-`, in order: (1) exactly one end marked possibly null (`?-` marks the right end, `-?` the left) → that end is the FK, so everything the writer writes reads back by its mark, whatever the keys say (the shared-primary-key pattern included); (2) a bare or doubly marked `-` → Import's foreign-file rule: from = **right**, unless only the right end is its table's whole primary key, then from = left (so an assistant's FK-first `Ref: fct.fk - dim.pk` reads as meant); (3) an end whose table the reader does not have → from = right. |
| many-to-many | `Ref: from.fc <>? to.tc` | `<>`: from = left |
| (one-to-many) | never written: `canonicalRelationship` turns it into many-to-one | `<` (hand-written) is read as `many-to-one` with from = **right**, the canonical reading |

**Other parts of a Ref:**

- **Role**: the Ref name. Duplicate names are allowed (verified). There is no role when the Ref is unnamed. Any name is a role, as Import already reads it (`dbmlImport.ts:1023`, `normaliseRelationshipRole`), so `SCHEMA_CONTENT` and the format reference say: "Name a Ref only to give it a role; the name is shown on the line." A constraint name such as `fk_orders_customer` is therefore shown.
- **Composite FK**: one Ref, `a.(x, y) > b.(u, v)`. In memory it is N entries sharing a `compositeKey`, **derived on read** (§2.4).
- **Settings**: `[delete: cascade]`, `[color: …]` and any other Ref settings are never read and are kept when the Ref is rewritten (§4.5). Refs take no custom properties (`[3035]`), which is why the role is the name.

**Constraints the writer enforces** (`DbmlEditRefused`):

- A Ref whose two ends are the same columns: DBML refuses it.
- Two units joining the same column sets, either way round (`[5001]`), **in any two relationships files**, not only in one: a diagram importing both files fails the same way. `planDbmlLibraryWrites` checks `linkKey` across every relationships file of the library (§4.6). Convert dedupes double-stored links (§6.1).
- A Ref from a DBML owner whose other end is a YAML table (D20).

### 2.4 Ownership and reading Refs into memory

- **Ends.** A Ref end is matched to a table by its table part with any schema qualifier removed, case-insensitively, against the library; a DBML alias declared in the referenced table file (`as FO`) is mapped to its table. Columns are matched case-insensitively and respelled to the table file's real spelling (`respellRelationship` semantics).
- **Owner.** The owner of a Ref is its canonical `fromModel` after the operator table above.
- **Attachment.** Every Ref the reader reads, from **any** relationships file, is attached to its owner when the owner is a **DBML** table. A Ref that sits in a file other than its owner's folder file is **misplaced**: it is attached and drawn, with a warning, and the next write that changes the owner's relationships, name or folder moves it to its home file in the same edit (§4.6). A Ref owned by a YAML table or by no table is **orphaned**: not attached, reported by `doctor` (§7.1), and never touched by the writer.
- **Duplicates across files.** When the same link (`linkKey`) is read from two files, or twice from one (a git auto-merge), the reader keeps one with the `mergeLibraryRelationships` ranking (`domain.ts:770-797`), warns, and `doctor` reports the files.
- **Which files are read.** The host reads every relationships file in the library. Core's loader reads the relationships files of every folder in its probe set (§4.4 step 6), which holds every member's folder; a misplaced Ref in the file of a folder with no member and no layer is the one case only the host draws, and `doctor` reports it as misplaced.
- **Composite keys.** Refs are attached in file order. For one owner, a composite Ref's members share `compositeKey = nextCompositeKey(entriesSoFar, toModel)`: the planner's own function, **moved to core** (`packages/core/src/relationships.ts`) and re-exported from `src/services/libraryRelationships.ts` (`fk_<to>`, then `_2`, `_3`, …), applied in file order. A one-column Ref gets no `compositeKey`.
- **Dangling ends.** A dangling end (a target with no table file, or a target column that is gone) is kept in the owner's list: it is not drawn, and a no-op write keeps it byte for byte, exactly like YAML today. Convert never **writes** one (§6.1).

### 2.5 Diagram file

**Example: `gold/sales.dbml`**

```dbml
Project sales {
  Note: 'Sales star schema'
  erd_schema_version: '7'
  erd_show_fk_edges: 'false'
  erd_layout_options: '{"elk.direction":"RIGHT"}'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use { table dim_customer } from '../tables/gold/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'
use * from '../tables/_relationships.dbml'
use * from '../tables/gold/_relationships.dbml'

Note "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c" [color: #f59e0b, linked_table: 'fct_order'] {
  'Check the grain with finance'
}

Note "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f" [color: #3b82f6] {
  ''
}
```

**Grammar, in the order the writer creates it:**

1. **`Project <ident(domain)> { … }`.** `domain` is the JSON `domain` value; for a new diagram that is the slug, as `createDomain` writes it today.
   - Its body holds `Note: '<description>'` (only when the description is non-empty), then the custom keys from the table below, in that order. Each key is written only when the in-memory value is defined.
   - `erd_schema_version` is always written.
   - Unknown Project keys (`database_type`, a team's own) are kept byte for byte.
2. **Table `use` lines**, one per `logical.models` entry, in list order: `use { table <declared reference> } from '<posix path from this diagram to the table file>'` (D17).
3. **Relationships `use` lines.** There is one `use * from '…'` for the `_relationships.dbml` of **every library folder holding at least one member table**, when that file exists after the edit. They come after the table uses, sorted by path. (The `use` lines of each relationships file are not transitive, so a diagram imports exactly the Refs whose two tables it imports itself; the others are dropped silently by every parser, verified.)
4. **Notes**: one `Note "<annotation id>" [color: <hex>, linked_table: '<name>'] { '<text>' }` per annotation, in `viewConfig.annotations` order, appended at the end of the file.
   - The name is always the id passed through `ident()`, so a UUID is quoted (verified).
   - `color` is the `DBML_RICH_STICKY_COLOURS` hex of the swatch, present only when set. `linked_table` (`DBML_RICH_NOTE_PROPERTIES.linkedTable`) is present only when `linkedModel` is set.
   - The body is `str(noteText(text))`, and an empty text is `''`.
   - On read, the colour goes back through `stickyColourOfHex`.

**Project keys.** New constants in `dbmlRichProperties.ts` as `DBML_DIAGRAM_PROPERTIES`:

| In memory (v5 object) | Project key | Value |
|---|---|---|
| `schemaVersion` | (none in the v5 object, which always holds `WRITTEN_SCHEMA_VERSION` = 5, D8) | |
| (beside the object) `DbmlSubjectAreaReading.schemaVersion` | `erd_schema_version` | `'7'` (missing on read → 7; not a whole number → `SubjectAreaValidationError`; > `CURRENT_SCHEMA_VERSION` → the "Please update the extension" refusal). Applied only to the Unified and Display `schemaVersion`. |
| `domain` | Project name | missing Project or name → the file stem |
| `description` | Project `Note` | `''` when absent |
| `modelFolder` | `erd_model_folder` | text |
| `viewConfig.showFkEdges` | `erd_show_fk_edges` | `'true'` / `'false'` |
| `viewConfig.layoutOptions` | `erd_layout_options` | JSON of the `Record<string,string>` |
| `stubColumns` | `erd_stub_columns` | JSON array of strings |
| `layer` | (none) | **always the parent folder name**. A `layer` change is refused by the writer; no handler makes one. |
| `logical.models` | table `use` lines | names = path stems (§3.4) |
| `logical.relationships` | (none) | always `[]` on read. A non-empty value is refused by the writer (D5). |
| `viewConfig.positions` | `.dbdiagram` `tablePositions` | §2.6 |
| `viewConfig.annotations[i].{id,text,color,linkedModel}` | `Note` blocks | as above |
| `viewConfig.annotations[i].{x,y,width,height}` | `.dbdiagram` `stickyNoteLayouts` | §2.6. `Annotation.x/y` are required numbers, so the reader places a Note with no layout entry itself, deterministically and parser-free (`placeUnlaidNotes` in `dbdiagramLayout.ts`): in a column to the right of every laid-out table position and Note, 40 px apart, in file order. It never writes; the next layout write persists whatever the canvas holds. Notes an assistant adds therefore never stack on the origin. |

**Diagram reading rules** (D6). The reader parses the AST, then **blanks** (replaces with spaces, line breaks kept) the spans of: every `use` declaration; every `Table`, `Ref`, `TableGroup`, `Enum`, `TablePartial`, `Records` and `DiagramView` element; every `Metadata` block (D25: its target is an imported or declared table, gone once those are blanked, so it would be a `[4000]`); every `Note` whose name repeats an earlier Note's (case-insensitive, as `[3003]` compares); and every `Project` after the first. It compiles the rest on its own and reads the Project and Notes from `rawDb`. Only **syntax** errors (1xxx) and errors left after blanking make the file unreadable (`invalid-dbml`).

- A blanked `Table`, `Ref`, `TableGroup`, `Enum` or `TablePartial` is not a member and is not drawn. Each gives one warning ("declared in the diagram file; ERD Studio shows only tables from the library through `use` lines") and a `doctor` problem, and is kept byte for byte.
- A blanked `Metadata` block gives one warning ("a Metadata block is declared in the diagram file; ERD Studio reads table properties only from the table file") and is kept byte for byte. Its values are not applied: ERD Studio reads a table's properties from its table file alone (D6). Other DBML tools, which compile the project, do apply them.
- A diagram that declares at least one `Table` and has **no** table `use` lines is most likely a dropped-in single-file DBML (a dbdiagram download or a rich export). The canvas shows a banner, "This file holds its own tables. **Import these tables…**", which runs Import DBML on it, and `doctor` raises the next step `import-dbml-file` (§7.1).
- A repeated Note name or a second Project gives a warning and is kept byte for byte; the first wins. The writer refuses to edit such a diagram (§4.5) until it is fixed, because it cannot tell which copy is meant.
- **Members.** The member named by a table `use` line is its path's **stem**, when the stem passes `isSafeTableName` and is not `_relationships`, whatever the folders in the path (D4). It is resolved by name in §3.4 order. A path that does not point at the file the name resolves to (a semantic-dir-relative `tables/gold/x.dbml`, a wrong folder, a case difference) is a `doctor` warning `usePathMismatch`. Core's reader sees the path shape and a specifier that names another table (compared without case, since a file may declare its name in another case than its stem, D2); a case difference from the file on disk needs a listing, so only the host and `doctor` see it, and the writer rewrites it on the next edit (§4.5, the target does not exist at that path). Relationships-file `use` lines (stem `_relationships`) are recognised and skipped. A `use` line whose stem fails `isSafeTableName` is ignored with a warning.
- **Folders.** Every folder named by a member's `use` path that is a library folder by the §2.1 rule goes into `useFolders`.
- A table listed twice (two `use` lines) is listed twice, as JSON allows.

### 2.6 Layout file (`<name>.dbdiagram`)

This is the JSON shape `dbdiagramLayout.ts` documents (version `"3.0.0"`). ERD Studio owns two lists in it:

```json
{
  "version": "3.0.0",
  "gridEnabling": false,
  "currentViewName": null,
  "defaultView": {
    "detailLevel": "All",
    "relationshipMode": "All",
    "tablePositions": [
      { "name": "fct_order", "schemaName": "public", "x": 400, "y": 200 },
      { "name": "dim_customer", "schemaName": "public", "x": 40, "y": 40 },
      { "name": "dim_date", "schemaName": "public", "x": 40, "y": 360 }
    ],
    "tableGroupCollapseStates": [],
    "stickyNoteLayouts": [
      { "name": "3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c", "x": 720, "y": 40, "width": 220, "height": 120 },
      { "name": "9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f", "x": 720, "y": 200 }
    ],
    "referencePaths": []
  },
  "views": {}
}
```

**`tablePositions`** mirror `viewConfig.positions` in order:

- `name` is the position key exactly, and `schemaName` is always `"public"` because names are unqualified (D2).
- x and y are canvas pixels rounded to two decimals.
- On read, entries are keyed by `name`; `schemaName` is ignored, and the first of a repeated name wins (`readDbdiagramLayout`). Stray positions (names not in the diagram) are kept, as JSON keeps them.

**`stickyNoteLayouts`** is the **documented best-guess shape** `{ name, x, y, width?, height? }`, which `readDbdiagramLayout` already reads:

- `name` is the Note's name (the annotation id);
- `width` and `height` are written only when they are defined and > 0.

dbdiagram may not read this shape, and parity is a non-goal.

**Writing (`editDiagramLayout`, parser-free, main entry):**

- When the text parses as a JSON object, ERD Studio replaces only `defaultView.tablePositions` and `defaultView.stickyNoteLayouts` and keeps every other key and value as parsed. It writes `JSON.stringify(obj, null, 2) + '\n'`.
- It returns `null` (no write) when both lists are deep-equal to what is there.
- A missing file is created only when there is at least one position or sticky layout.
- A file that does not parse as a JSON object is **refused** for writing. The read ignores it with a warning (D7).

The layout file is machine JSON: the two-space re-serialisation is its canonical form, and a file written by ERD Studio round-trips byte-identically.

### 2.7 `layers.json` and `templates/`

These do not change. They stay JSON with their schemas. Templates seed new tables, which a DBML project writes as DBML.

### 2.8 What is normalised or dropped

Nothing that matters is dropped. Each item below is either invisible or the documented semantics of the change. **This table is normative for the comparator** `normaliseForStorageEquivalence` (D24): it applies exactly these rows (the Convert-only rows only when comparing a Convert result), and nothing else.

| Item | Where | Why it is acceptable |
|---|---|---|
| Leading whitespace of a description, column note or sticky-note text | every write | The canvas never shows leading whitespace; this is the export's existing rule (`noteText`). The writer emits `dbmlString(dbmlNoteText(text))`, so the first line has no indent and DBML's shared-indent trim never applies to text ERD Studio writes (verified in 9.1.1, 10.3.1 and 11.0.0: `"  - bullet\n  - bullet2"` is written as `'''- bullet\n  - bullet2'''` and reads back as `"- bullet\n  - bullet2"`; the parser dedents only text whose every line shares the indent). The comparator applies `dbmlNoteText` and nothing more. |
| Positions beyond 2 decimals | layout file | Sub-pixel. The comparator rounds to 2 decimals. |
| `compositeKey` names, which are part of the display (`composite-and-self.host.json:120,129`) | relationships | They are derived again on every read (§2.4). They are internal grouping ids, never shown, and the planner needs them stable only within one read. The comparator renames every group's key to the `nextCompositeKey` sequence in the owner's order. |
| A one-member composite group (a lone `compositeKey`, `composite-and-self.unified.json:55`) | relationships | It is written as a plain one-column Ref and draws the same. The comparator drops a lone key. |
| Raw spellings of Ref ends (`Mentor_ID`, `EMPLOYEE_ID`, `Employee` in `composite-and-self.unified.json:110-112`) | relationships | Every end is respelled to the real table and column spelling (§2.3); DBML is case-sensitive, and the raw spelling fails `[4000]` (verified in all three parsers). The comparator respells ends against the library. |
| A library `one-to-many` entry (written by 1.6.6/1.6.7) | relationships | Stored canonically (`canonicalRelationship`): many-to-one from the other end, from/to swapped. The comparator canonicalises. |
| A link stored twice (in both ends' yml files, or twice in one) | Convert only | One Ref, chosen with the `mergeLibraryRelationships` ranking, which already draws it once. Listed in the notes. |
| A composite group whose members disagree on role | Convert only | The first member's role, as `assembleGroups` (`domain.ts:894-899`) already draws it. Listed in the notes. |
| A dangling relationship (target table without a file, or target column gone) | Convert only | Written as a `//` commented-out Ref line under a one-line explanation in the owner's relationships file, never as a live Ref (it would fail `[4000]`). It was not drawn before and is not drawn after. Listed in the notes. |
| A duplicate sticky-note id in one JSON diagram | Convert only | The second and later get a new UUID (DBML refuses two Notes with one name, `[3003]`). Listed in the notes; the comparator ignores annotation ids. |
| A Ref's `?` marks | relationships | ERD Studio records no nullability (D18). |
| Relationships held in diagram files | Convert only | They move to the library (`planMoveToLibrary` semantics) and from then on draw in every diagram that has both ends. The preview lists the affected diagrams (§6). |
| JSON `layer` key | Convert only | Becomes the folder. `resolveSubjectAreaLayer` already makes them agree; a disagreement is a refusal. |
| YAML comments, unknown yml keys, anchors/aliases (expanded), unknown domain-JSON keys | Convert only | Carried as a `// Kept from <old path> by Convert Project to DBML:` comment block with the original lines (YAML text, or `"key": <JSON>`) above the Table or Project, and listed in the notes. The text survives; ERD Studio does not read it. |
| DBML-only settings from Import | Import only | Kept in `meta.dbml` (D19), as in YAML. |
| `schemaVersion` 4/5/6 → 7 | Display and Unified | D8. The comparator overrides it. |
| The order of relationships (added in S2) | relationships | A relationships file keeps its Refs sorted (§4.5 step 3), so a link's place in the drawn list carries no meaning; relationships a diagram file held are drawn in the library's order once stored there. The comparator sorts every list by the §4.5 sort key (from table, to table, from columns, to columns, case-insensitive), a composite group moving as one unit at its first member's key with its members in their order. |
| An empty sticky-note list (added in S2) | diagram | A diagram with no `Note` blocks reads back with no `annotations` list; a JSON file may hold `"annotations": []`. The comparator treats an empty list as none. |

---

## 3. Format detection and versioning

### 3.1 Versions

In `packages/core/src/types/semantic.ts`:

```ts
export const CURRENT_SCHEMA_VERSION = 7;        // newest schema core reads, in any format (was 6)
export const CURRENT_JSON_SCHEMA_VERSION = 6;   // newest a JSON subject area may declare
export const DBML_SCHEMA_VERSION = 7;           // written as erd_schema_version on a DBML diagram
```

- `validateSubjectAreaDocument` compares JSON against `CURRENT_JSON_SCHEMA_VERSION`. It keeps the message word for word (`only supports up to version ${CURRENT_JSON_SCHEMA_VERSION}`), so `errors.future.host.json` does not change.
- A DBML diagram whose `erd_schema_version` is greater than `CURRENT_SCHEMA_VERSION` throws `SubjectAreaValidationError("<path> has erd_schema_version N but this extension only supports up to version 7. Please update the extension.")`.
- `DisplaySubjectArea.schemaVersion` is 7 for a DBML diagram.
- Table files and relationships files carry no version; the diagram's version gates the format.
- `WRITTEN_SCHEMA_VERSION` and `TABLE_NAMING_SCHEMA_VERSION` do not change.

### 3.2 Storage detection (the single answer)

In core (`packages/core/src/types/semantic.ts`, beside `detectProjectNaming`):

```ts
export type ProjectStorage = 'yaml' | 'dbml' | 'mixed';
export interface ProjectStorageEvidence {
  /** Any *.yml table file in logical-models/ or tables/ (top level or one folder down). */
  hasYamlTables: boolean;
  /** logical-models/ exists, empty or not, and tables/ is not the DBML library (projectNamingOf's hasV5Folder rule). */
  hasV5Folder: boolean;
  /** Any *.dbml table file in tables/ (classifySemanticFile → 'table'), or any relationships file. */
  hasDbmlTables: boolean;
  /** The storage of every subject area file: 'json' or 'dbml'. */
  subjectAreaStorages: Iterable<'json' | 'dbml'>;
}
/** 'dbml' when nothing exists (a new project). */
export function detectProjectStorage(evidence: ProjectStorageEvidence): ProjectStorage;
/** Whether new files are DBML: 'dbml' and 'mixed' (the caller also checks that tables/ is not a layer). */
export function writesDbml(storage: ProjectStorage): boolean;
```

**Rules.** *YAML evidence* is `hasYamlTables`, `hasV5Folder`, or any `'json'` subject area. *DBML evidence* is `hasDbmlTables` only: library files, never a diagram alone.

| Evidence | Answer |
|---|---|
| no YAML evidence and no DBML evidence (`.dbml` diagrams alone count as none) | `dbml` |
| YAML evidence, no DBML evidence (`.dbml` diagrams beside it included) | `yaml`; `doctor` warns "DBML diagram in a YAML project" for each `.dbml` diagram |
| DBML evidence, no YAML evidence | `dbml` |
| both | `mixed` |

An empty `logical-models/` is YAML evidence exactly as `projectNamingOf` treats it (`src/services/projectNaming.ts:52-58`): an older version made it, and its files go there. So the test helper `createTempWorkspace` (`test/unit/logicalModelService.test.ts:20-24`), which makes an empty `logical-models/`, keeps every existing `saveTable` test on YAML.

**The host wrapper** is `projectStorageOf(tableLibraryService, subjectAreaService)` in `src/services/projectStorage.ts`, beside `projectNamingOf`. It is memoised with `namingMemo` and invalidated the same way.

- It returns the storage to **write**: when `tablesDirIsLayer()` holds, it returns `'yaml'` whatever the evidence. A DBML project never has a `tables` layer (addLayer refuses it, and Convert refuses a project that has one).
- The canvas, every create and import command, the offers, the context key `erdStudio.storage` and `doctor` call **only** this.
- `projectNamingOf` stays the naming answer for YAML writes. In a DBML project it is ignored, because the DBML library is always `tables/`.
- **One switch-over stage.** Until S6, the host's default create paths (`newTablePath` for a table not added through a DBML diagram, `createDomain`, `setupSemanticDirectory`, the import and draw commands) keep today's YAML/JSON behaviour; S5 writes DBML only for existing DBML tables and for tables added to a DBML diagram (D20 forces those to DBML). S6 flips every default to `projectStorageOf` at once and updates the existing tests whose temp workspaces have no YAML evidence (§10 S6 lists them).

### 3.3 `tables/`: library or layer

`tablesDirIsLayer()` (`logicalModelService.ts:41`) gains one input, *DBML evidence in `tables/`*: a `*.dbml` file at the top level or one folder down (no content sniff). With *json* = a `*.json` file at the top of `tables/` and *listed* = `layers.json` lists `tables`:

| DBML evidence | json | listed | `tables/` is | `doctor` |
|---|---|---|---|---|
| no | any | any | a layer when json or listed (**today's rule, unchanged**) | |
| yes | no | no | the library | |
| yes | no | yes | **the library**: the DBML evidence beats a `tables` entry that a 1.x first-run layer prompt or **Initialize Layer Config** wrote (both count only `.yml`, `logicalModelService.ts:62-71`, `extension.ts:2541-2547`, `:2941-2966`) | error `tablesLayerConflict`: "layers.json lists `tables`, but tables/ is the DBML table library. Remove the `tables` layer from layers.json." |
| yes | yes | no | **the library**; each `tables/*.json` is classified `other` | error `tablesLayerConflict` naming the `.json` files |
| yes | yes | yes | a layer (the YAML project's explicit layer wins; its `.dbml` files are `other`) | error `tablesLayerConflict` naming the `.dbml` files |

- `hasTablesLibrary()` (`:62`) becomes: `tables/` exists, is not a layer, and holds a `*.yml` **or a `*.dbml` (relationships files included)** at the top level or one level down.
- `LayerService.detectLayersFromFilesystem` therefore never offers a DBML `tables/` as a layer, and `addLayer` refuses `tables` (as today) in every project.
- The canvas shows the `tablesLayerConflict` text as a warning toast once per session in a project where it holds. Nothing reclassifies silently.
- Every way a 2.0 project is created writes `layers.json` (`setupSemanticDirectory`, `createDomain`, the harness's new-project instructions, §7.3), and `doctor` raises a warning `missingLayersConfig` when a project with a DBML library has none.

### 3.4 Table resolution order (parity between core and host)

One function in core decides where a name lives:

```ts
export function tableFileCandidates(prefix: string, name: string, folders: readonly string[], options: { dbml: boolean }): string[];
```

The candidates are:

1. `logical-models/<name>.yml`, then `logical-models/<f>/<name>.yml` for each `f` in `folders`;
2. then, for each `sub` in `['', ...folders]`: `tables/<sub><name>.dbml` (only when `options.dbml`), then `tables/<sub><name>.yml`.

`folders` is sorted with `localeCompare` and de-duplicated. Within one directory `.dbml` beats `.yml`; across directories the existing rule holds (`logical-models/` first, top level before folders).

**Using it:**

- **Core** uses it in `loadDisplaySubjectArea` (`loadDisplayDomain.ts:276-286`). `folders` is the domain layer, plus every layer id, plus (for a DBML diagram) every library folder named in its `use` lines (`useFolders`). Core has only `readFile`, so it probes with the member's spelling, which on a case-sensitive file system finds exactly what the YAML probe finds today; the file's declared name then sets the identity (D2).
- **The host** (`findTableFile`, `listTableFiles` shadowing) applies the same precedence over the folders it lists, with `.dbml` probed in the same order. It **resolves from the directory listing**, never with `fs.existsSync`: on macOS and Windows `existsSync('tables/dim_x.dbml')` is true for `tables/Dim_X.dbml`, and the looked-up spelling would leak into `parseTableDbml` (a false `nameMismatch`) and into `use` paths that then fail on Linux. `findTableFile` matches the listing case-insensitively (as `findTableNameIgnoringCase` already does) and always returns, and passes on, the **listed** stem and path.
- A name found in two places is a reported conflict, as today (`shadowedBy`). `doctor` adds the cross-format case "x.yml and x.dbml".
- **Parity of folders.** Core's probe set is narrower than the host's listing (a member in a non-layer folder that no `use` path names, which only a JSON diagram can have). That is today's YAML behaviour, unchanged. Convert's self-check therefore resolves both sides from the input file **listing** (§6.1), never through core's probe.

### 3.5 File classification (single classifier)

In the parser-free core module `packages/core/src/storage.ts`:

```ts
export type SemanticFileKind = 'diagram' | 'table' | 'relationships' | 'layout' | 'layers' | 'template' | 'other';
export interface SemanticFileClass { kind: SemanticFileKind; storage?: 'json' | 'dbml' | 'yaml'; layer?: string; folder?: string; name?: string; }
/** `relPath`: posix, relative to the semantic dir. `firstLine`: the file's first line, when the caller has read it. */
export function classifySemanticFile(relPath: string, options: { tablesDirIsLayer: boolean; firstLine?: string }): SemanticFileClass;
export function subjectAreaStorageOf(path: string): 'json' | 'dbml' | undefined; // by extension
export function relationshipsFilePathOf(tableFilePath: string): string;     // same dir + DBML_RELATIONSHIPS_FILE_NAME
export function layoutFilePathOf(diagramPath: string): string;              // .dbml → .dbdiagram
export function diagramPathOfLayout(layoutPath: string): string;            // .dbdiagram → .dbml
export function isReservedTableName(name: string): boolean;                 // sameName(name, '_relationships')
export function isLibraryFolderName(name: string): boolean;                 // non-empty, no '/', '\\', NUL, not '.'-leading: the listFoldersOf rule
// posix helpers (core may not import node:path): normalisePosix, joinPosix, dirnamePosix, relativePosix, resolvePosix, isInsidePosix
```

`ERD_STUDIO_DBML_HEADER_PREFIX` moves from `src/services/dbmlImportParse.ts:196` to `packages/core/src/dbmlRichProperties.ts` and is re-exported there, so the classifier can use it.

**Rules**, with `relPath` split into segments (folders by `isLibraryFolderName`):

- `layers.json` → `layers`.
- `templates/**` → `template`.
- `logical-models/<n>.yml` or `logical-models/<f>/<n>.yml` → `table` (yaml).
- When `tables/` is not a layer (§3.3):
  - `tables/[<f>/]<n>.dbml` with `isReservedTableName(n)` → `relationships`;
  - `tables/[<f>/]<n>.dbml` → `table` (dbml);
  - `tables/[<f>/]<n>.yml` → `table` (yaml), `_relationships.yml` included (an existing YAML table, §2.1);
  - anything else under `tables/` → `other`.
- `<d>/<n>.json` → `diagram` (json) when `d` ∉ `NON_SUBJECT_AREA_DIRS` and `d` is not the library.
- `<d>/<n>.dbml` → `diagram` (dbml) when the `.json` rule holds, `<n>` is not reserved, **and** `firstLine` (when given) does not start with `ERD_STUDIO_DBML_HEADER_PREFIX` (a rich export saved there is `other`). Callers that list diagrams (`listSubjectAreas`, `doctor`, `inventory`, Convert's input reader) read the first line and pass it; the watchers and the decoration provider classify by path only.
- `<d>/<n>.dbdiagram` → `layout`, under the path conditions of the `.dbml` rule.
- Everything else → `other`.

**`NON_SUBJECT_AREA_DIRS` is not changed.** It is a public export, and the library exclusion depends on `tablesDirIsLayer`.

**Users:**

- `isSubjectAreaFilePath` (`domainService.ts:68`);
- `classifySemanticPath` (`FileWatcherService.ts:73`);
- `SemanticFileDecorationProvider`;
- `listSubjectAreas`, `listTableFiles`;
- the custom-editor reroute;
- `doctor`, `inventory`;
- the Convert input reader.

### 3.6 Behaviour of older software on a DBML project

| Reader | What happens |
|---|---|
| Extension ≤ 1.7.x | Selector `*/*.json` only, so no `.dbml` opens as a canvas, the Subject Areas view lists no DBML diagrams, and the Table Library lists no `.dbml` tables (it lists `.yml` only). `hasTablesLibrary` is false for a DBML `tables/`, so its first-run layer prompt (only without `layers.json`) and **Initialize Layer Config** can offer `tables` as a layer and write it into `layers.json`. 2.0 then still treats `tables/` as the library and reports `tablesLayerConflict` (§3.3). Its **Update All** of the AI helper files would put the v34 text back (it calls a newer marker "outdated", `harnessService.ts:1001`); 2.0's `doctor` then raises `update-harness` again. Convert's offer and modal tell the user that everyone needs 2.0 (§6.2). |
| Harness v34 assistants | Their schema skill reads only `erd.naming` (it never reads `nextSteps`) and says "create new table files in `tables/`" as YAML (`harnessService.ts:142`, `:157-158`), so they may write v6 YAML into the project, making it `mixed`. 2.0 still reads those files. `doctor` 2.0 raises `update-harness` for **every** outdated harness target (§7.1), and the 2.0 extension shows a toast when a `.yml` table or `.json` diagram that ERD Studio did not write appears in a DBML project (§5.4). |
| CLI ≤ 1.7.x | `listSubjectAreas` ignores `.dbml` and `doctor` reports no diagrams. It is read-only, so it is harmless. |
| `@erd-studio/core` ≤ 0.3.0 | `loadDisplaySubjectArea` on a `.dbml` path throws `SubjectAreaFileError('invalid-json', transient)`. This is a breaking note in the core changelog, and the Confluence app must bump (§1). |

---

## 4. Architecture

### 4.1 Module map

**Core, main entry (parser-free, imports no `@dbml/parse`):**

| File | New or changed | Content |
|---|---|---|
| `packages/core/src/types/semantic.ts` | changed | version constants (§3.1); `ProjectStorage`, `detectProjectStorage`, `writesDbml`; `TableLoadErrorKind` gains `'dbmlSyntax' \| 'dbmlInvalid' \| 'dbmlStructure'`; `TableLoadError` gains optional `code?: string` |
| `packages/core/src/types/dbmlStorage.ts` | new | the **types** of the reader the loader is handed (§4.3), with no values |
| `packages/core/src/storage.ts` | new | the classifier, candidates, posix helpers and reserved name (§3.4, §3.5) |
| `packages/core/src/dbmlText.ts` | new | `str`, `ident`, `columnType`, `noteText` and `DBML_KEYWORDS`, **moved** out of `exportDbmlRich.ts` (export output unchanged, goldens identical) |
| `packages/core/src/dbmlRichProperties.ts` | changed | adds `DBML_DIAGRAM_PROPERTIES`, `DBML_RELATIONSHIPS_FILE_NAME`, `DBML_RELATIONSHIPS_FILE_HEADER`, `DBML_STORAGE_PLACEHOLDER_NOTE` (the existing placeholder note text, now shared) |
| `packages/core/src/dbdiagramLayout.ts` | changed | adds `editDiagramLayout(oldText: string \| null, positions: Record<string, NodePosition>, stickies: DbdiagramStickyLayout[]): string \| null`, `stickyLayoutsOf(annotations)` and `placeUnlaidNotes` (§2.5) |
| `packages/core/src/relationships.ts` | changed | `nextCompositeKey` **moved here** from `src/services/libraryRelationships.ts:231` (which re-exports it), so the reader and the planner share one function |
| `packages/core/src/storageEquivalence.ts` | new | `normaliseForStorageEquivalence(display, options: { convert?: boolean })` (D24, §2.8) |
| `packages/core/src/domain.ts` | changed | `SubjectAreaFileErrorReason` gains `'invalid-dbml'` (§4.7); format-aware `classifyTableLoadError` / `describeTableLoadError`; the warning at `:659` becomes neutral (§4.7) |
| `packages/core/src/loadDisplayDomain.ts` | changed | the `.dbml` branch, the `dbml` option, `maxRelationshipsChars` and the candidate probe (§4.4) |
| `packages/core/src/index.ts` | changed | exports all of the above, and **no value** from `src/dbml/` |

**Core, subpath `@erd-studio/core/dbml`** (`packages/core/src/dbml/`; the **only** files that import `@dbml/parse`):

| File | Content |
|---|---|
| `parser.ts` (**internal**, never exported) | wraps `@dbml/parse`: `compileOne(text, virtualPath='/erd-studio/file.dbml', parser?)`, `astOf`, `diagnosticsOf` (1-based line and column, numeric code, message), `errorClassOf(code)`: 1000–1999 → `syntax`, 3000–3999 → `invalid`, 4000–4001 → `binding`, 5000+ → `interpreter`. `propertyText(v, text)` returns a 9/10 plain string as is; for an 11.0.0 `{value, type, token}` it returns `.value` for `string` and `color`, and for `number` and `bool` the literal's own source text (the token's text after the attribute's `:`, trimmed; §2.2 "Typed values on read") together with a `typed: true` flag the readers turn into `unquotedValue`. `diagnosticsOf` and every file-path read use `Filepath#absolute`, never the `filepath` JSON (`{path}` in 9/10, `{root, segments}` in 11). `blankSpans(text, nodes)` keeps offsets and line breaks. `stripBom(text)`. An LRU cache of ASTs keyed by text hash (the writers re-use the reader's parse of the same text, §4.5). |
| `parserModule.ts` | `interface DbmlParserModule { Compiler; MemoryProjectLayout; Filepath; … }`: the **own** minimal structural type of the parser module, so the optional `parser` parameter never names a type from `@dbml/parse` |
| `readTable.ts` | `parseTableDbml(text, fileStem, parser?): DbmlTableReading` |
| `readRelationships.ts` | `readRelationshipsDbml(text, parser?): DbmlRelationshipsReading` (AST, Ref by Ref) and `attachRelationships(...)` (§2.4) |
| `readDiagram.ts` | `parseSubjectAreaDbml(text, filePath, layoutText, parser?)`, `subjectAreaMembersDbml(text, parser?)` |
| `splice.ts` | `TextEdit {start,end,text}`, `applyTextEdits(text, edits)` (sorted, non-overlapping, else throws), and line, indent and EOL helpers |
| `writeTable.ts` | `renderNewTableDbml(table)`, `editTableDbml(oldText, desired, options)` |
| `writeRelationships.ts` | `editRelationshipsDbml(oldText \| null, edit)` |
| `writeDiagram.ts` | `renderNewSubjectAreaDbml(input)`, `editSubjectAreaDbml(oldText, edit)` |
| `compileProject.ts` | `compileDbmlProject(files: Record<string,string>, entries: string[], parser?): Record<string, DbmlDiagnostic[]>`, a multi-file compile for `doctor`, Convert's self-check, e2e and the multi-parser tests. Keys are posix paths **relative to the semantic dir**; it mounts them under the space-free virtual root `/erd-studio/`, so the result never depends on where the project lives: the pinned 11.0.0 has no space bug, but the multi-parser tests and `scripts/e2e-dbml.mjs` also run it with 10.3.1 (the `dbml-parse-v10` alias), which silently drops imported tables when any folder in the absolute path holds a space. Diagnostics come back keyed by the relative path, taken from each diagnostic's `Filepath#absolute`. |
| `errors.ts` | `class DbmlEditRefused extends Error { file; line? }` |
| `index.ts` | exports the readers, writers, `compileDbmlProject`, `DbmlEditRefused`, `DbmlParserModule` and `dbmlStorageReader`, every one typed only with ERD Studio's own types. It exports nothing from `parser.ts`. |

**Host:**

| File | New or changed | Content |
|---|---|---|
| `src/services/projectStorage.ts` | new | `projectStorageOf` (§3.2) |
| `src/services/fileWrites.ts` | new | `type FileWrite = {kind:'replace';path;text} \| {kind:'create';path;text} \| {kind:'delete';path}`, `mergeFileWrites` (one write per path, else throws) and `orderFileWrites` (D23: creates with relationships files first, then replaces, then deletes) |
| `src/providers/applyFileWrites.ts` | new | `applyFileWrites(writes, { primary?, before })`: builds the one WorkspaceEdit, applies it, and reconciles on `false` (§5.3). The only place a provider or command applies `FileWrite`s through VS Code |
| `src/services/fsFileWrites.ts` | new | `writeFilesWithRollback(writes)`: the fs twin for non-editor paths (§5.1). It snapshots every target first and restores every snapshot on failure (the `newSubjectAreaWriter` rollback, generalised), keeps a BOM the file had, and records ownWrites after the bytes land |
| `src/services/dbmlLibraryWrites.ts` | new | pure planner `planDbmlLibraryWrites` (§4.6), vscode-free and CLI-safe |
| `src/services/logicalModelService.ts` | changed | listing, probe, caches and `planTableWrites` (§5.1) |
| `src/providers/subjectAreaCodec.ts` | new | `JsonSubjectAreaCodec`, `DbmlSubjectAreaCodec` (§5.2) |
| `src/services/dbmlConversion.ts`, `src/services/dbmlConversionFiles.ts`, `src/commands/convertProjectToDbml.ts` | new | §6 |

**Bundle rule.** These are enforced by `test/unit/packagesBoundary.test.ts` and `test/unit/cli.noVscode.test.ts`:

1. Nothing outside `packages/core/src/dbml/` imports `@dbml/parse`. The host's `src/services/dbmlImportParse.ts` keeps its own import, which is allowed.
2. No module reachable from `packages/core/src/index.ts` makes a value import from `./dbml/`.
3. Nothing under `webview/` or `packages/renderer/` imports `@erd-studio/core/dbml`. `tsconfig.webview.json` deliberately has **no** path for it, so such an import fails type-checking.
4. After `npm run build`, `dist/webview.js` contains no `@dbml/parse` code. The test greps for a marker string unique to the parser, such as `UNEXPECTED_ELEMENT_DECLARATION`.
5. `dist/cli.js`, `dist/extension.js` and `mcp-server/dist/*.js` each contain **exactly one** copy of the parser: the marker string occurs as often as in one bundled copy (3 times for both 10.3.1 and 11.0.0, measured; the test records the baseline, S8), never twice that. A drift between core's pin and the root pin would otherwise silently bundle two copies of about 435 KB (11.0.0 and 10.3.1 bundle to within 2 KB of each other, minified).
6. No emitted `packages/core/dist/dbml/*.d.ts` contains the text `@dbml/parse` (D12).

**Plumbing for the subpath:**

- `packages/core/package.json` gets the export `"./dbml": { "types": "./dist/dbml/index.d.ts", "default": "./dist/dbml/index.js" }` and `"dependencies": { "yaml": "^2.9.0", "@dbml/parse": "11.0.0" }`, and loses its `@dbml/parse` devDependency entry (10.3.1 today). Its parser-alias devDependencies become `"dbml-parse-v9": "npm:@dbml/parse@9.1.1"` (unchanged) and **`"dbml-parse-v10": "npm:@dbml/parse@10.3.1"` (new)**; **`dbml-parse-v11` is removed**, because the pin itself is 11.0.0 and an alias of the same version would be a second name for it that silently stops meaning "the pin" at the next pin bump. Run `npm install` at the root and commit the regenerated `package-lock.json` (CI's `npm ci` fails on a stale lock).
- `packages/core/build.mjs` becomes **one** esbuild call: `entryPoints: ['src/index.ts', 'src/dbml/index.ts']`, `bundle: true`, `splitting: true`, `format: 'esm'`, `platform: 'neutral'`, `outdir: 'dist'`, `external: ['yaml', '@dbml/parse']`. Shared modules (`domain.ts` and its error classes) land in one chunk both entries import, so `instanceof SubjectAreaFileError` holds for an error thrown by `dbmlStorageReader.parseSubjectArea` (the renderer's `build.mjs` is the precedent). The output paths are `dist/index.js` and `dist/dbml/index.js` (set `entryNames: '[dir]/[name]'` with `outbase: 'src'`). Check that `tsconfig.build.json` emits `dist/dbml/*.d.ts`.
- Root `tsconfig.json` and `mcp-server/tsconfig.json` get `"@erd-studio/core/dbml": ["…/packages/core/src/dbml/index.ts"]`, listed **before** `@erd-studio/core`.
- `vitest.config.ts` gets the alias `{ find: /^@erd-studio\/core\/dbml$/, replacement: …/src/dbml/index.ts }`.
- Root `package.json` moves its `@dbml/parse` dependency from `"10.3.1"` to **`"11.0.0"`**, in the same commit as core's (rule 5).
- `test/unit/packagesNodeNext.test.ts` adds `@dbml` to its dependency symlink list (`:110`) and a consumer that imports `@erd-studio/core/dbml` under `skipLibCheck: false`.
- `packages/core/README.md` documents the subpath.

**Parser pin 11.0.0 (S2).** Liam chose 11.0.0 (Appendix, question 1). S2 moves both pins, because core gains the dependency there; S1 is parser-free and only has to use the 11.0.0 error-code numbering for the hint (§4.7), which 10.3.1 shares. What changes with the pin:

- **Tests keep reading every written file with 9.1.1, 10.3.1 and 11.0.0**: 9.1.1 through `dbml-parse-v9`, 10.3.1 through the new `dbml-parse-v10`, 11.0.0 through the pinned `@dbml/parse` itself. The existing tests that import `dbml-parse-v11` or treat the pinned parser as 10.3.1 switch in S2: `packages/core/test/exportParsers.ts` (imports; `RICH_DBML_PARSERS` order unchanged; `DBML_PARSERS[0]` becomes `'@dbml/parse 11.0.0'`; the header comment), `test/unit/dbmlImportParse.test.ts`, `test/unit/dbmlImport.test.ts` and `test/unit/dbmlRoundTrip.test.ts` (each parser list becomes 9.1.1 → v9, 10.3.1 → v10, 11.0.0 → pinned; `dbmlImport.test.ts` "reads the same plan from 11.0's typed metadata" compares the v10 alias against the pinned parser instead).
- **Import DBML reads with 11.0.0** (`readDbml`'s `PINNED_PARSER`). It already reads property values in both shapes (`dbmlPropertyText`: a string, or `{value, type}` with a string, number or boolean value), so the only behaviour change is that a file with unquoted number or boolean custom values (`[n: 2]`, `[natural_key: true]`), which 10.3.1 refused, now imports. Their text is `String(value)` (`007` → `7`, `1e3` → `1000`, `TRUE` → `true`), as Import already reads 11.0 output today; storage reads the literal's text instead (§2.2), because storage round-trips and Import does not. Nothing else in Import changes, verified: `readDbml` is a single-file parse under `DEFAULT_ENTRY` and reads only token `start.line` / `start.offset` and `nodeOrToken.startPos`, never a `filepath`, so the 11.0.0 `{root, segments}` filepath shape does not reach it; Project values stay plain strings; a Note's `color` stays a string; the `[3019]` "These fields must be some inline settings" message `importDbml.ts` matches (`SEVERAL_FIELDS_ON_ONE_LINE`) is identical; a `use` line still fails `[4001]` in a single-file parse, as in 10.3.1 (and §5.7's multi-file refusal runs before the parse anyway); every `.dbml` fixture and golden in the repo (28 files) and the built-in coffee-shop example parse with no errors in all three. The one existing test that relied on 10.3.1, `dbmlImportParse.test.ts` "reports a custom property 10.x refuses (an unquoted number) at its line", is rewritten to an unquoted word (`[n: two]`, refused by all three with `/must be a string/`), and a v10 case keeps the number refusal.
- **Messages change wording** for value errors under 11.0.0 ("must be a string, a color literal, a number literal, or a boolean literal"); no code or test depends on the old full text (`/must be a string/` still matches).
- **The export is unchanged**: `toDbml` and `toDbmlRich` already write only quoted values, every rich golden is already held to all three parsers, and `parseDbml` ("the current `@dbml/parse`") now means 11.0.0.
- `docs/dev/dbml.md`'s Parser bullets (`:25-26`: 10.3.1, "never a runtime dependency of `@erd-studio/core`", the `dbml-parse-v11` alias) get the three facts corrected in S2 (11.0.0, a core runtime dependency, tests read with `dbml-parse-v9`, `dbml-parse-v10` and the pin), so the developer doc is never wrong about the pin; S9 rewrites the section fully (§8.1).

### 4.2 Shared text helpers

`packages/core/src/dbmlText.ts` holds the exact current implementations of `str`, `ident`, `columnType`, `noteText` and `KEYWORDS`, exported (as `dbmlString`, `dbmlName`, `dbmlColumnType`, `dbmlNoteText`, `DBML_KEYWORDS`). `exportDbmlRich.ts` imports them. Every `*.rich.dbml` golden must stay byte-identical; that is the acceptance check for the move.

### 4.3 Readers

```ts
// packages/core/src/types/dbmlStorage.ts (types only; main entry)
export interface DbmlProblem {
  file?: string; line?: number; column?: number; code?: number | string; message: string;
  severity: 'error' | 'warning';
  mergeConflict?: true;                     // the file holds git conflict markers: never pick a side (§7.1)
}
export type DbmlTableReading =
  | { ok: true; table: SemanticTable /* relationships unset; name = declared spelling */; declaredName: string; declaredReference: string /* 'x' or 'gold.x', as Ref ends and use specifiers spell it */; alias?: string; schemaQualified: boolean; writable: boolean /* false while an inline ref / use / Ref line is present (§2.2) */; problems: DbmlProblem[] }
  | { ok: false; error: TableLoadError & { column?: number; message: string } };
export interface DbmlStoredRef {
  owner: string; target: string;            // table parts as spelled in the file (qualifier removed, alias kept for the attach step)
  relationships: Relationship[];            // canonical, one per column pair, file order, no compositeKey yet
  start: number; fullEnd: number;           // the Ref node span (writers re-read; readers ignore)
  oneToOneDirection?: 'mark' | 'keys' | 'position';  // how a '-' Ref was oriented (§2.3), for the attach step
}
export interface DbmlRelationshipsReading { readable: boolean; refs: DbmlStoredRef[]; problems: DbmlProblem[]; }
export interface DbmlSubjectAreaReading {
  obj: Record<string, unknown>;             // v5-shaped (§2.5), schemaVersion 5 (D8), layer = folder
  schemaVersion: number;                    // erd_schema_version (7 when missing): applied to Unified/Display only
  members: string[];                        // = obj.logical.models
  useFolders: string[];                     // library folders named by table use lines ('' = top level)
  writable: boolean;                        // false with a repeated Note name or a second Project (§2.5)
  warnings: string[];
}
export interface DbmlStorageReader {
  parseTable(text: string, fileStem: string): DbmlTableReading;
  readRelationships(text: string): DbmlRelationshipsReading;
  parseSubjectArea(text: string, filePath: string, layoutText: string | null): DbmlSubjectAreaReading; // throws SubjectAreaFileError / SubjectAreaValidationError
  subjectAreaMembers(text: string): string[] | null;  // AST only, no compile; null when the text does not parse
}
```

Every reader strips a leading BOM first (§2.1) and takes an optional last `parser?: DbmlParserModule` argument (the pinned 11.0.0 `@dbml/parse` when omitted), which is how the tests feed the `dbml-parse-v9` and `dbml-parse-v10` aliases. `DbmlStorageReader` itself has no parser parameter; `dbmlStorageReader` binds the default.

**`parseTableDbml`** works like this:

1. Empty text → `{ok:false, kind:'read'}`.
2. Check for merge-conflict markers first (`findConflictMarkers`) → `dbmlSyntax` with `mergeConflict: true`.
3. Parse the AST. Blank every `use` line, `Ref` element and column `ref:` setting (§2.2), each recorded as a problem, and set `writable: false` when there was any.
4. `compileOne` the text under a fixed virtual path, never the real one (11.0.0 does not care, but the 10.3.1 alias the tests feed would drop the table under a path with a space).
5. Any `syntax` error → `dbmlSyntax`. Any `invalid` (3xxx) or `interpreter` error → `dbmlInvalid`; for `[3025]` and `[3075]` (11.0.0's codes for an unquoted column or table value: a word, a phrase or `null`) the message ends with "Quote the value, as in `grain: 'One row per order line'`." The codes are the pinned parser's numbering (the parser facts above §0); `[3073]` is not in the list, because in 10.3.1 and 11.0.0 it is a TablePartial error. Any remaining `binding` error (a partial) → `dbmlStructure`. Each carries the first error's line, column and code.
6. Structure checks (§2.2) → `dbmlStructure` with a message naming the rule. The stem and the declared name compare case-insensitively.
7. Map `rawDb.tables[0]` per §2.2. Drop the placeholder. Read custom values with `propertyText`, accepting the `erd_` prefix (`bareDbmlProperty`) and 11.0's typed values (each one an `unquotedValue` warning, §2.2). Mirror `yamlToTable`'s normalisation exactly:
   - `scdType` is an integer 0–2 or absent; `additiveType` is in the union; `modelRole` is any string, as YAML keeps it.
   - `meta` is read through core's `readMeta` rules. `meta_json` is parsed as JSON, and invalid JSON is a warning, with the entry kept as the string under the key `json`. `meta_<key>` entries win over the same key inside `meta_json`.

**`readRelationshipsDbml`** works from the AST, never `rawDb`:

1. Conflict markers, or any `syntax` error → `{readable:false}` with no Refs and a problem (with `mergeConflict` for markers). `hasUnreadableRelationships` then becomes true, and writes to the file are refused.
2. Otherwise each `<element-declaration>` whose `type.value` is `Ref` (in short `Ref: …` or block `Ref { … }` form) is read on its own:
   - the endpoints, the operator token, any `?` marks and the name come from the node (`propertyText` / token `.value`);
   - binding errors (`[4000]`, `[4001]`: a missing `use` target or a deleted table file) are ignored, because the AST still holds every Ref node with its offsets (verified);
   - a Ref node that cannot be read becomes a problem and is skipped.
3. A `-` Ref whose direction needs keys (§2.3, case 2) is returned with `oneToOneDirection: 'keys'` and both ends unoriented; `attachRelationships`, which has the tables, orients it.
4. It never throws.

**`attachRelationships(readings: Array<{path, reading}>, tables: (name) => {name, folder, storage, primaryKey, columns, alias?} | undefined)`** applies §2.4: it maps ends (qualifiers, aliases, case), orients key-dependent one-to-ones, respells, dedupes the same `linkKey` across all readings with the `mergeLibraryRelationships` ranking (with a warning naming both files), derives `compositeKey`s with `nextCompositeKey`, and returns `{ byOwner: Map<lowerName, TableRelationship[]>, misplaced, orphaned, duplicates }`. Core and host call this one function.

**`parseSubjectAreaDbml`** works like this:

1. Empty → `SubjectAreaFileError('empty')`.
2. Conflict markers → `'invalid-dbml'` with `mergeConflict`, not transient.
3. Parse the AST. A syntax error → step 5. Blank the spans §2.5 lists (`use`, `Table`, `Ref`, `TableGroup`, `Enum`, `TablePartial`, `Records`, `DiagramView`, `Metadata`, repeated Notes, later Projects), each with its warning, and compile the rest on its own.
4. Errors left after blanking are only possible from constructs ERD Studio does not know. The parser gives no `rawDb` when any error is left, so any error left, a `binding` one included, goes to step 5 (S2 deviation; every construct that names a table, D25's `Metadata` blocks included, is blanked in step 3).
5. A `syntax` or remaining `invalid` error → `SubjectAreaFileError('invalid-dbml', path, msg, {line, column})`, transient (a half-written file). The message reads "Invalid DBML in subject area file <path> at line L, column C: <first diagnostic>"; for `[3063]` (an unquoted Project key, rejected by every parser) and `[3051]` (an unquoted Note setting word) it adds "Quote the value, as in `erd_schema_version: '7'`."
6. Build `obj` per §2.5 from `rawDb` (Project name, Note and custom keys, plain strings in every parser; Notes with `metadata.linked_table` through `propertyText` and `color`). Read the layout through `readDbdiagramLayout`; its problems become warnings. Place Notes with no layout (`placeUnlaidNotes`).
7. Check the version (`schemaVersion` beside `obj`, D8).

**`dbmlStorageReader`** is the object `{ parseTable: parseTableDbml, readRelationships: readRelationshipsDbml, parseSubjectArea: parseSubjectAreaDbml, subjectAreaMembers: subjectAreaMembersDbml }`.

### 4.4 `loadDisplaySubjectArea` with DBML

The new options are `dbml?: DbmlStorageReader` and `maxRelationshipsChars?: number` (default `Infinity`, checked by the same finite-limit rule as the others). A `.dbml` `domainPath` without `dbml` throws `SubjectAreaValidationError("<path> is a DBML diagram; pass dbml: dbmlStorageReader from '@erd-studio/core/dbml' to read it.")`.

**Not a diagram.** Before reading, core classifies `domainPath` relative to the semantic dir by path shape: a `.dbml` under `tables/` (top level or one folder down, whatever `layers.json` says: a `.dbml` there is DBML evidence, so §3.3 makes `tables/` either the library, where it is a table, or a YAML project's layer, where it is `other`; `classifySemanticFile` never calls it a diagram under either answer, so core needs no listing), or a stem equal to `_relationships`, throws `SubjectAreaValidationError("<path> is a DBML table or relationships file, not a diagram. Open a diagram in a layer folder.")`. This is what the `errors.dbml-not-a-diagram` golden records.

The steps for a DBML diagram:

1. Read the diagram and check `maxDomainChars`. Read `layoutFilePathOf(domainPath)`; if it is over `maxDomainChars`, ignore it with a warning.
2. Call `dbml.parseSubjectArea`.
3. Read `layers.json` as today. `resolveSubjectAreaLayer(obj.layer = folder, …)`.
4. `maxModels` counts `members`.
5. Resolve each unique, filtered name through `tableFileCandidates(prefix, name, folders, {dbml: true})`, where `folders` = the sorted, unique union of the domain layer, the layer ids and `useFolders`. Parse with `parseTableText` (`.yml`) or `dbml.parseTable` (`.dbml`). `maxYamlChars` limits a `.dbml` table file as written; over it, the table is a placeholder, like `YamlCharLimitError`. `maxYamlNodes` does not apply to DBML (document this on the option). A member that resolves to a `.yml` is drawn and gets a warning (D20).
6. Read the relationships file of **every folder in the probe set** (`''` and every entry of `folders`) that exists; that set holds every folder where a member resolved to a `.dbml`. Apply `maxRelationshipsChars`; over it, read no Refs from **that file** and warn "tables/…/_relationships.dbml is larger than the limit; its relationships are not drawn". Call `dbml.readRelationships` on each, then one `attachRelationships` over all of them onto the DBML tables read in step 5 (§2.4: misplaced Refs attach too, duplicates are removed), with `partial: true`: core read only the members, so a Ref whose owner it did not read (a table off this diagram, or one whose file did not read) is skipped without a warning rather than reported orphaned. The host passes the whole library and leaves `partial` unset. Unreadable files and problems become warnings.
7. Build and place positions as today. Set the Unified and Display `schemaVersion` from `reading.schemaVersion` (D8).

**JSON diagrams** with the `dbml` option also probe `.dbml` candidates and run step 6 when any member is found as `.dbml`, so a JSON diagram in a mixed project draws DBML tables and their library relationships. Without the option, JSON loading is byte-for-byte today's behaviour.

The four error classes are unchanged. `'invalid-dbml'` is a new `SubjectAreaFileError` reason: a public type change, noted in the 0.4.0 "Changed (breaking)" section.

### 4.5 Writers (splicer design)

All writers live in `packages/core/src/dbml/`. They are pure, deterministic and never touch disk. The common contract:

- Input is the current text (or `null` for a new file) and the desired in-memory state. Output is the new text, built **only** by `applyTextEdits` over node offsets from `astOf(oldText)`. The writers are never the YAML regenerate path.
- A leading BOM is stripped before parsing and put back on the output when it was there (§2.1). Host callers pass the document's text, which never holds one.
- `oldText` that fails the reader's parse (syntax or invalid errors, structure errors, conflict markers), or that the reader marks `writable: false` (§2.2, §2.5) → `throw new DbmlEditRefused(file, "Fix the DBML in <file> first (line L: <diagnostic>). ERD Studio never rewrites a file it cannot read.")`, with the reader's own message (the line to move, the repeated Note) where it has one.
- **Deleting a node** always cuts from the **line start of its `start`** to its **`fullEnd`** (its trailing same-line comment and line break included). `fullStart` is never used for a cut: it includes the comment lines above the node, and for the first element of a file the file's header comment (verified). Comment lines above a deleted node therefore stay where they are.
- **Derived blocks are touched only when their inputs change in this edit** (D7): a relationships file's `use` lines only for the tables of Refs this edit inserts, regenerates, moves or deletes, and for tables in the edit's `pathChanged`; a diagram's relationships `use` lines only when its membership changes or the caller passes `refreshRelationshipsUses` (the settle pass, §5.3); the PK form only when the desired PK **set** differs from the set read (so a valid `indexes { id [pk] }` stays as written); `meta_json` only when the parsed object of the non-`meta_<key>` entries differs from what was read, comparing after applying the `meta_<key>`-wins rule.
- **Law 1, no-op:** `edit(t, read(t)) === t` for **every** `t` the reader accepts as writable (not only files the writer produced). The law fixtures include hand-written files with extra or missing `use` lines, unsorted Refs, `indexes { id [pk] }`, `primary key` flags, `erd_`-prefixed names and a `meta_<key>` that overrides a key in `meta_json`.
- **Law 2, idempotent:** `edit(edit(t, x), x) === edit(t, x)`.
- **Law 3, round trip:** `normaliseForStorageEquivalence(read(edit(t, x))) = normaliseForStorageEquivalence(x)` (D24).
- **Law 4, preservation:** every byte outside the spans of changed nodes is unchanged, so comments and unknown constructs survive.
- **Law 5, parses:** when the input parses in all three (or is `null`), the output parses with no errors in 9.1.1, 10.3.1 and 11.0.0, as a multi-file project together with its `use` targets. When the input holds an 11.0-only typed value (§2.2), the output parses in 11.0.0 and the edit adds no 11.0-only syntax of its own (the law fixtures include such a file).
- Values are compared **by the value read**, never by spelling: `"x"` and `'x'` are equal. An unchanged value is never rewritten.

**`editTableDbml(oldText, desired: SemanticTable, { rename?: boolean })`:**

- **Table name** (rename): replace the name token's span with `ident(desired.name)`. A schema-qualified name keeps its qualifier; a DBML alias (`as X`) is kept.
- **Table settings and properties** (`role`, `grain`, `alias`, `schema`, `rationale_*`, `meta_*`, `meta_json`):
  - **changed**: replace that attribute's value span. If the file spells the name `erd_<x>`, the name is kept.
  - **added**: append `, <k>: <v>` to an inline list, or a new line `<indent><k>: <v>` with a comma added after the previous attribute in a multi-line list, or, when there is no list, insert ` [<k>: <v>]` **immediately before the body's `{`**, which puts it after the name and after any DBML alias (`Table x as X [k: 'v'] {` parses in all three, verified, and checked again by the S3 multi-parser test).
  - **removed**: delete the attribute and its separating comma (plus its own line in a multi-line list). Remove the brackets when the list becomes empty.
  - **Meta:** only the properties whose value changed are touched. `meta_json` is recomputed from the desired non-`meta_<key>` entries and rewritten only when its parsed JSON differs.
- **Description**: replace the body `Note` value span (or the header `note` value). Add `<indent>Note: <v>` as the last body line, or remove the Note's line.
- **Columns** are matched desired ↔ current by name, case-insensitively (exact case first). Unmatched columns pair by position only when exactly one was removed and one added at the same index: that is a rename, the `syncColumns` rule.
  - **matched**: splice the name, type and settings as for table settings. `note` is the column description.
  - **added**: a new line built like `renderNewTableDbml`'s column line, inserted after the line of the previous desired column. The first column goes before the first column, or after `{` when there is none.
  - **removed**: delete the column from the line start of its `start` to its `fullEnd` (the cut rule above). Comment lines **above** it are kept.
  - **reordered** (`reorderColumns`): rebuild the column region. Each column block (the text from the line start of its `fullStart` to its `fullEnd`: its lines plus the comment lines directly above it) is emitted in the desired order. The first column's block starts no earlier than the line after `{`, so a comment above the Table never moves. Non-column body elements stay after the region.
- **Primary key**:
  - desired PK set of size 1 → `pk` on that column, with the `pk` index line removed if present;
  - size ≥ 2 → one `(a, b) [pk]` line in `indexes { … }` (a new block before the body `Note`, or the existing pk line replaced) and the column `pk` / `primary key` flags removed;
  - size 0 → all removed.

  Other index lines are untouched. An `indexes` block left empty is removed.
- **Placeholder**: no desired columns → ensure the placeholder line. Columns plus a placeholder → remove the placeholder line.

**`renderNewTableDbml(table)`** is used by create, Convert, Import and templates. It applies the §2.2 layout. `read(renderNewTableDbml(t)) ≅ t` for every fixture table.

**`editRelationshipsDbml(oldText | null, edit)`:**

```ts
interface RelationshipsFileEdit {
  filePath: string;                                   // posix, for relative use paths
  /** Owners whose complete list for THIS file this edit sets, keyed lower-case. null = drop every Ref it owns here. Owners not listed keep their Refs byte for byte. */
  owners: Map<string, { name: string; relationships: TableRelationship[] } | null>;
  /** Owner renames done in this edit: old lower-case → new name (its Refs are re-spelled even if otherwise unchanged). */
  renamedOwners?: Map<string, string>;
  /** Ref texts moving INTO this file from another file (a moved owner, a misplaced Ref going home), carried verbatim (§4.6). */
  incoming?: Array<{ text: string; unit: RefUnit }>;
  /** Tables whose path changed in this edit (rename, move, delete): their use lines are re-resolved even if no Ref changed. */
  pathChanged?: ReadonlySet<string /* lower name */>;
  /** AFTER this edit: real spelling, declared reference ('x' or 'gold.x'), real column spellings, file path and storage of a table a Ref may name; undefined = no file. */
  resolve(name: string): { name: string; reference: string; columns: (col: string) => string | undefined; path: string; storage: 'yaml' | 'dbml' } | undefined;
}
```

1. Read the current Refs with `readRelationshipsDbml` and group them by owner (case-insensitive, ends mapped as §2.4). The relationships-level `readable` must be true, else refuse.
2. For each owner in `owners`, group the desired entries into units: by `compositeKey`, else one entry each. Group the current entries into units: one Ref each. A unit is `{from, to, fromCols[], toCols[], cardinality, role}`, compared without `compositeKey` and without `?` marks.
   - an **identical** unit keeps its Ref text;
   - a unit with the **same ends and columns** but a different cardinality or role is **regenerated** at its place. It keeps the original `[settings]` text and trailing comment, and moves only if its sort key changed (an end renamed);
   - a current unit with no desired match → cut the Ref (the cut rule above);
   - a desired unit with no current match → insert at its sorted position (an `incoming` text for that unit is inserted verbatim instead of being generated, re-spelled only where an end was renamed).
   - Refuse a unit that joins the same columns at both ends, two units with the same endpoint sets, and a unit whose other end `resolve`s to `storage: 'yaml'` (D20: "Convert the project to DBML first (ERD Studio: Convert Project to DBML)"). Cross-file duplicates are the planner's check (§4.6).
3. **Sort key**: `owner.toLowerCase() \0 target.toLowerCase() \0 fromCols.join(',') \0 toCols.join(',')`. Insert before the first existing Ref, in file order, whose key is greater; else after the last Ref. Existing lines are never reordered apart from step 2's moves.
4. **Ends**: every regenerated or inserted Ref spells each end with `resolve(name).reference` and each column with `resolve(name).columns(col)` (the real spellings, schema qualifier included). An end with no file keeps the in-memory spelling: a dangling Ref, already in the data. Operators follow the §2.3 table, FK end marked (D18).
5. **`use` lines.** Let C be the tables named by Refs this edit inserted, regenerated, moved in or out, or deleted, plus `pathChanged`. For each table in C only: when a Ref left in the file names it, make sure exactly one `use` line resolves to `resolve(t).path` (rewrite a line whose target moved, insert a missing one at its sorted position in the `use` block); when no Ref left names it, delete its library-pointing `use` lines. `use` lines for tables outside C are never touched (Law 1). A new line is `use { table <reference> } from '<path>'`; a rename rewrites both the specifier and the path of the line. The `use` block of a file with none goes after the file's **header comment**, defined once in `splice.ts` as `headerEnd(text, ast)`: the comment lines at the very top of the file that are followed by a blank line (the writer's own header is always followed by one). When the leading comment lines run straight into the first element with no blank line, they describe that element, and the block goes at offset 0 instead, followed by one blank line. It never lands between a comment and the element it describes. Tests cover both shapes, for relationships files and for the Project block of §`editSubjectAreaDbml`, which uses the same `headerEnd`.
6. A `null` `oldText` creates `DBML_RELATIONSHIPS_FILE_HEADER + '\n' + uses + '\n\n' + refs + '\n'`. A file left with no Refs keeps its header and comments and loses its `use` lines; it is never deleted (D15).

**`editSubjectAreaDbml(oldText, edit)`:**

```ts
interface SubjectAreaDbmlEdit {
  filePath: string;
  before: Record<string, unknown>;   // the v5 object as parsed (snapshot), schemaVersion 5 (D8)
  after: Record<string, unknown>;    // after the handler's mutator
  resolveTable(name: string): { name: string; reference: string; path: string; storage: 'yaml' | 'dbml' } | undefined;  // after this edit
  /** Tables whose file moved, was renamed or was deleted in this edit (the library plan's pathChanged). */
  pathChanged?: ReadonlySet<string /* lower name */>;
  /** The relationships files (paths after this edit) of the library folders holding these DBML tables. */
  relationshipsFilesFor(memberNames: readonly string[]): string[];
  /** Recompute the relationships use lines even when membership did not change (the settle pass, §5.3). */
  refreshRelationshipsUses?: boolean;
  /** Whether a file exists AFTER this edit (posix, relative to the semantic dir), from the caller's listing plus the plan's writes. */
  fileExists(path: string): boolean;
}
```

It diffs `before` against `after`:

- **Refusals:**
  - the reading is `writable: false` (a repeated Note name or a second Project, §2.5);
  - `after.logical.relationships` non-empty, which tells the user relationships live in the table library;
  - a `layer` or `schemaVersion` change (the object's `schemaVersion` stays 5; the DBML version is not in it, D8);
  - a change to any key other than the ones mapped in §2.5;
  - a **new** member whose `resolveTable` is undefined or `storage: 'yaml'` (D20).
- **Project**: a name, Note or custom-key change is a value splice. A key added goes in after the last known key and a key removed loses its line. A diagram with no Project block gets one, inserted at `headerEnd` (§`editRelationshipsDbml` step 5), when any Project-held value is set.
- **Table `use` lines**: compute the old and new lists of `logical.models`.
  - A member removed → cut its line. A member added → insert after the last table `use` line, in list order.
  - The order changed (no handler does this today) → rebuild the table-use block.
  - **A line is rewritten only when** its member is in `pathChanged` (rewrite specifier and path from `resolveTable`; a deleted member's line is cut), or the file its path points at **does not exist** after this edit (a wrong or stale path, §2.5: rewrite the path to `resolveTable(name).path`). A line whose target exists is never repointed, even when the name resolves elsewhere first: with two copies of a name (a reported conflict), each diagram keeps the copy it uses, which is the duplicate resolver's rule (§5.7).
  - An existing member that resolves to a `.yml` (mixed project) keeps its line bytes; the reader warns (D20).
  - Every other line keeps its bytes (`use *` and `use { table x }` alike).
- **Relationships `use` lines** are recomputed only when membership changed or `refreshRelationshipsUses` is set: the desired set is `relationshipsFilesFor(after members)`. Add and remove lines as for the relationships file's `use` block. Otherwise they keep their bytes (Law 1).
- **Notes**: match annotations to Notes by id.
  - text, colour or link changed → splice the body value or settings;
  - added → a block appended at the end;
  - removed → cut the block (the cut rule above).
- **Rename of the diagram** (`renameDomain`, §5.7) is an edit whose `after.domain` differs: the same Project-name value splice. No caller splices a Project name by hand.
- **`renderNewSubjectAreaDbml({domain, description, modelFolder?, showFkEdges?, layoutOptions?, stubColumns?, members: [{path}], relationshipsFiles, annotations})`** builds the §2.5 layout in order.

The layout file is handled separately by `editDiagramLayout(oldLayoutText, after.viewConfig.positions ?? {}, stickyLayoutsOf(after.viewConfig.annotations ?? []))`.

#### 4.5.x `Metadata` blocks in a table file (D25)

- **Detection.** While locating a property to edit, the table writer also walks the file's AST for `Metadata Table <this table>` and `Metadata Column <this table>.<col>` blocks (case-insensitive name match, as everywhere). The effective source of a property is the **last** block entry in the file that sets it, else the inline setting.
- **Edit.** A changed value is spliced into the winning block entry (quoted, as every written value). A cleared value removes the block entry (and an inline duplicate, if both exist, so nothing resurfaces). A block left empty is kept as written (never deleted; the user wrote it). An inline setting shadowed by a block is never edited on its own.
- **Renames.** Renaming a column or table updates the `Metadata Column t.c` / `Metadata Table t` target in the same file, so the block keeps pointing at it (a stale target is a [4000] that blanks the whole table).
- **Deletes.** Deleting a column removes `Metadata Column t.c` blocks targeting it.
- **Other files.** Blocks in another file that targets this table through `use` are not edited; the edit is refused with `DbmlEditRefused` naming that file and line ("<prop> is set by a Metadata block in <file>:<line>; edit it there"). ERD Studio never writes such files.
- **Built-ins.** `note` and `headercolor` set by a block follow the same rules as custom properties.

### 4.6 Library write planner (host, pure)

`src/services/dbmlLibraryWrites.ts`:

```ts
export interface DbmlLibrarySnapshot {
  semanticDir: string;
  /** Every table file the library lists (TableLibraryService.listTableFiles), winners only, keyed lower-case; paths and stems from the listing (D2). */
  tables: Map<string, { name: string; reference: string; path: string; storage: 'yaml' | 'dbml'; folder: string; columns: string[] }>;
  /** Every relationships file in the library, with its reading (cached AST, §5.1). */
  relationshipsFiles: Map<string /* path */, DbmlRelationshipsReading>;
  /** Every existing path the snapshot knows (tables, relationships files, diagrams, layouts). */
  files: ReadonlySet<string>;
  readText(path: string): string | null;          // open document text first, else disk; BOM stripped
}
export interface DbmlLibraryOps {
  save: Array<{ model: SemanticTable; fromName?: string }>;   // DBML tables only; YAML saves stay on today's path
  delete: string[];
  move?: Array<{ name: string; toFolder: string }>;          // organise
  newTableFolder?: string;                                    // where new tables go (newTablePath rules)
}
export interface DbmlLibraryWritePlan {
  writes: FileWrite[];
  /** Resolver AFTER the plan: real name, declared reference, real column spellings, path, storage. */
  resolveTable(name: string): { name: string; reference: string; columns: (col: string) => string | undefined; path: string; storage: 'yaml' | 'dbml' } | undefined;
  relationshipsFilesFor(names: readonly string[]): string[];
  fileExists(path: string): boolean;
  /** Relationships files this plan creates (diagrams with members in that folder need a use line). */
  createdRelationshipsFiles: string[];
  /** Tables whose path changed (rename/move) or that were deleted: diagrams using them need a re-render. */
  pathChanged: Map<string /*old lower*/, string | null /*new path, null = deleted*/>;
}
export function planDbmlLibraryWrites(snapshot: DbmlLibrarySnapshot, ops: DbmlLibraryOps): DbmlLibraryWritePlan; // throws DbmlEditRefused
```

**Algorithm:**

0. **Normalise the ops.** A `delete` entry that names a `save` entry's `fromName` is folded into that rename and dropped from `delete`: `handleRenameModel` passes `save: [{model, fromName: old}]` **and** `delete: [old]` (`SemanticEditorProvider.ts:3985-3991`), and acting on both would either throw in `mergeFileWrites` or drop every Ref the renamed table owns. A test covers exactly this ops shape.
1. Build the path overlay. A new name gets `newTablePath(name, newTableFolder)` with `.dbml`. A rename gets the old folder with the new stem. A move gets `toFolder`. A delete gets null.
2. Write each table file:
   - an existing table → `editTableDbml(readText(oldPath), model, {rename})`; on a rename or move, `create(newPath, text)` + `delete(oldPath)`; else `replace(path, text)` when the text changed;
   - a new table → `create(path, renderNewTableDbml(model))`;
   - a delete → `delete(path)`.
3. Group owners by the relationships file of their folder **after** the plan. A saved model whose `relationships` changed, a renamed owner (every owned Ref re-spelled), a moved owner and a deleted owner (`null`) each contribute to the right file's `RelationshipsFileEdit`:
   - **Moving Refs between files** (a moved owner, and every **misplaced** Ref of an owner whose relationships, name or folder this plan changes, §2.4; a column-only save moves nothing): the Ref is cut from the file it is in (`owners` there drops it) and its **original text** is passed as `incoming` to the home file, re-spelled only where an end was renamed, so `[delete: cascade]`, `?` marks and its trailing comment survive (Law 4). A misplaced Ref of any other owner is left where it is.
   - One `editRelationshipsDbml` call per affected file yields **one** write per file: a replace, or a create when `oldText` is `null`.
4. Any table whose path changes is passed in `pathChanged` to **every** relationships file whose Refs name it, even when no owner there changed, so the `use` paths stay valid.
5. **Cross-file duplicates.** After placing, the planner computes `linkKey` over every Ref in every relationships file as it will be after the plan. A link present twice (in any two files, or twice in one) throws `DbmlEditRefused("<a> and <b> both hold the relationship <from.col → to.col>. Remove one of them first.")` unless this plan is removing one of the copies.
6. **YAML ends.** A Ref this plan inserts or regenerates whose other end is a YAML table throws the D20 refusal (also raised by `editRelationshipsDbml`; checked here first so the message names the diagram action).
7. `mergeFileWrites` makes sure no path is written twice.

This planner only **places** tables and Refs in files. It never decides orientation, ownership or which relationships exist; that stays with `planRelationshipWrite` and the cascades in `libraryRelationships.ts`. Convert (§6.1), `resolveDuplicateModel` and the fs paths (§5.1) call it too; nothing else calls `editRelationshipsDbml`.

### 4.7 Errors and messages

- **`TableLoadErrorKind`** gains `dbmlSyntax`, `dbmlInvalid` and `dbmlStructure`.
  - `classifyTableLoadError` maps DBML failures through `errorClassOf`. `code` is `String(dbmlCode)`, or `'structure:<rule>'` for ERD Studio's own rules: `notOneTable`, `nameMismatch`, `unsupportedElement`. (`useInTableFile`, `refInTableFile` and `inlineRefInTableFile` are warnings on a loaded table, §2.2, not load errors.)
  - `describeTableLoadError` gets new wording: "table file has a DBML syntax error", "table file is not valid DBML (<code>)", "table file has an unquoted value; quote it, as in grain: 'One row per order line'" (for `3025` and `3075`, the pinned 11.0.0's codes, which 10.3.1 shares; never `3073`, a TablePartial error there) and "table file must hold exactly one Table that needs no other file".
  - The YAML wording (`domain.ts:729-743`, "logical-models file has a YAML error…") does not change.
- **The warning "not found in logical-models/"** (`domain.ts:659`) and the relationship-mismatch text "but logical-models/ defines it as" (`:826`) become "not found in the table library" and "but the table library defines it as". `golden/logs.json` is regenerated, an intended text change, and so are the assertions on that text in `packages/core/test/unit/domain.test.ts` and `packages/core/test/unit/loadDisplayDomain.test.ts`; noted in the core changelog.
- **Exhaustive fallouts** (all in S1):
  - `src/services/telemetryPayload.ts:788` — new codes, §7.4;
  - `src/cli/diff.ts:92` `TABLE_YAML_HINTS` — becomes `TABLE_FILE_HINTS`, with DBML hints that depend on the error's code: "fix the DBML at line N" (with the quote advice appended only for `DBML_TABLE_QUOTE_HINT_CODES`, never `3073` or any other code); for `dbmlStructure`, one fix per rule (`notOneTable` "a table file holds exactly one Table", `nameMismatch` "name the Table as its file", `unsupportedElement` "remove the Project, TableGroup, Note or other block"), "fix the DBML at line N" for a parser (binding) code, and "a table file holds exactly one Table, named as its file, and no Project, TableGroup or Note" without a code. Never advice about `use` or `Ref` lines, which are warnings on a loaded table, not load errors. The broken-table notification's tip (`openModelFile.ts`) follows the same code rules;
  - `src/commands/openModelFile.ts:31`;
  - `packages/renderer/src/components/Graph/ModelNode.tsx:560` — "YAML error" becomes `yaml*` → "YAML error", `dbml*` → "DBML error", `read` → "unreadable", written as `kind.startsWith('dbml') ? … : <upstream>` so older cores render unchanged;
  - `src/services/commandErrors.ts:159` `describeDiagramFileProblem` — `'invalid-dbml'` keeps its Open File button at line and column;
  - the webview's "isn't valid JSON" and "Open as JSON file" (`webview/App.tsx:284-292,492-502`, `webview/components/Toolbar/Toolbar.tsx:1026-1055`) — become "isn't valid <JSON|DBML>" and "Open file", where the file type comes from the error's file extension.
- **`DbmlEditRefused`** maps to `EditRefused` in the provider, so the message is shown as the existing toast. In commands it is shown as a modal with the file name and an Open File button.

---

- **Metadata target missing (D25).** A [4000] "cannot find metadata target element" maps to a precise `describeTableLoadError` message naming the missing table or column ("A Metadata block on line N targets column 'x', which this table does not have; rename or remove the block"), not the generic DBML error; `doctor` reports it as a warning-level problem with that text.

## 5. Host integration

### 5.1 `TableLibraryService` (`src/services/logicalModelService.ts`)

- **`listTableFiles()`**:
  - accept `.yml` and `.dbml` (via `classifySemanticFile`), in every library folder by the §2.1 rule (`listFoldersOf`);
  - skip relationships files (`.dbml` with the reserved stem); a `_relationships.yml` is an ordinary YAML table (§2.1);
  - give each entry `storage: 'yaml' | 'dbml'`;
  - apply the §3.4 shadowing (within one directory `.dbml` wins and the `.yml` gets `shadowedBy`);
  - for a `.dbml`, take the name from the **listed** stem; the declared name must match it case-insensitively, else it is a load error at read time (D2). Once the file is read, the entry's display name is the declared spelling.
- **`findTableFile` / `v5FileIgnoringCase` / `tablePath` / `renamedTablePath`** probe both extensions in §3.4 order **against the directory listing** (case-insensitive match, listed stem and path returned), never with `fs.existsSync` (§3.4).
- **`newTablePath(name, folder)`** stays private; a new public wrapper **`pathForNewTable(name, folder?)`** is what `syncPlanBuilder` (§5.7) and `diff` (§7.1) call. From S6 it chooses `.dbml` in `tables/` when `writesDbml(projectStorageOf())`, else today's rule (§3.2, one switch-over stage).
- **`findTableNameIgnoringCase`** already lists files, so it covers `.dbml`. It does not refuse reserved names (§2.1: only create paths do).
- **One private reader, `readTableEntry(entry)`**, is the only place a table file is read. `getTable`, `listTables()` (`:757-771`) and `hasUnreadableRelationships()` (`:786-797`) all go through it, so `listTables()`, which feeds `planRelationshipWrite` (`SemanticEditorProvider.ts:3834`), `usesLibraryRelationships`, `routeAddedRelationships` (`:1953`), `otherLibraryTables` and the state-space harness, returns DBML tables **with** their relationships. A test asserts that.
  - `.yml` → today's `readTableFile`; `.dbml` → `parseTableDbml` (subpath), cached by `mtime:size` as today;
  - relationships are **not** part of that cache entry;
  - a new `relationshipsCache: Map<path, {key, text, reading}>` caches every relationships file's reading (and through `parser.ts`, its AST, which the writers reuse for the same text);
  - the attachment (one `attachRelationships` over **every** relationships file, §2.4) is memoised against the set of cache keys and recomputed at call time when any changed, so a relationships-file change needs no table-cache flush;
  - `invalidateCache()` clears all three.
- **`getTable` failures** for DBML build a `TableFileError` with the DBML kinds and codes (`:128-174`).
- **`hasUnreadableRelationships()`** is also true when any relationships file is unreadable (§4.3).
- **`usesLibraryRelationships`** (`libraryRelationships.ts:34`) is true whenever any DBML table or relationships file exists.
- **`planTableWrites(ops: TableFileOps, layerFolder?): { writes: FileWrite[]; plan?: DbmlLibraryWritePlan }`** is the one entry for the provider and commands:
  - YAML tables go through today's `serializeTable` / `renamedTablePath` / `tablePath` rules, as replace or create writes;
  - DBML tables go through `planDbmlLibraryWrites`; a new table added through a **DBML diagram** is always DBML (D20), from S5 on;
  - a save whose old file is YAML and target is DBML never happens outside Convert: an existing table keeps its format.
- **New helpers:**
  - `relationshipsFileFor(tableName): string | undefined` (for `diff` fixes);
  - `tableStorage(name)`;
  - `dbmlSnapshot()`.
- **`saveTable` / `renameTable` / `deleteTable`** (the non-editor fs paths used by `newSubjectAreaWriter`, `deleteLogicalModel`, organise and resolve duplicate) route DBML tables through `planDbmlLibraryWrites` and apply the writes with **`writeFilesWithRollback`** (§4.1): it snapshots every target before the first write and, on any failure, restores every snapshot (deleting what was created, re-creating what was deleted, putting back replaced text), then removes folders it made. A partial failure can therefore never leave table files, relationships files and `use` lines out of step. ownWrites are recorded after each write lands.
- **`ensureDir`** already accepts `tables/[folder/]`. It is called **only for library paths**; a diagram or layout create (`<layer>/<name>.dbdiagram`) creates its folder with a plain `mkdir` of the layer folder, which already exists for any open diagram.
- **BOM.** The fs paths keep a BOM a file had (§2.1).

### 5.2 Subject-area codec (`src/providers/subjectAreaCodec.ts`)

```ts
interface ParsedSubjectArea {
  storage: 'json' | 'dbml';
  parsed: Record<string, unknown>;      // a v5 object with schemaVersion 5 for DBML (D8), so every detector call site sees v5
  snapshot: Record<string, unknown>;
  dbmlSchemaVersion?: number;           // DBML only: erd_schema_version, never written back by an edit
  writable?: boolean;                   // DBML only: the reader's writable flag
  layoutPath?: string; layoutText?: string | null;
}
interface SubjectAreaCodec {
  parse(text: string, filePath: string, layoutText: string | null): ParsedSubjectArea;   // throws EditRefused (SubjectAreaFileError mapped as today)
  render(p: ParsedSubjectArea, text: string, resolver: SubjectAreaResolver): FileWrite[];  // FIRST entry is always the primary replace, even when identical
  tableNames(text: string, filePath: string): string[] | null;
}
function codecFor(filePath: string): SubjectAreaCodec;   // by subjectAreaStorageOf
```

- **The JSON codec** is today's `parseSubjectAreaDocument` + `serialiseSubjectArea` + `tableNamingDocuments`, moved behind the interface with **no behaviour change**.
- **The DBML codec:**
  - takes the layout text from an open `TextDocument` for `layoutFilePathOf(path)` if there is one, else from disk;
  - `parse` uses the subpath `parseSubjectAreaDbml`, with `snapshot = structuredClone(parsed)`;
  - `render` uses `editSubjectAreaDbml` for the primary (always returned) and `editDiagramLayout` for the layout (a replace, a create, or nothing).
- **The shared helper `subjectAreaTableNames(text, path)`** (JSON: `getRawSubjectAreaTableNames(JSON.parse)`; DBML: `subjectAreaMembersDbml`) is the **only** raw membership reader. It replaces the ad-hoc parses in:
  - `ModelLibraryTreeProvider.buildUsageMap`;
  - `organizeModelLibrary`, `resolveDuplicateModel`;
  - `countSubjectAreaFileRelationships` (DBML → 0);
  - `readSubjectAreaRelationships` (DBML → []);
  - `refreshSubjectAreasReferencingTable` (`:3154-3180`);
  - `recordCanvasOpen` / `recordRelationshipState`;
  - `cli/inventory.ts:228`;
  - MCP `read_domain`.

  It lives in `src/services/domainService.ts` so the CLI and MCP bundle it.

### 5.3 `SemanticEditorProvider` edit pipeline

`applySubjectAreaEdit` keeps its order and adds three steps:

1. **Parse** with `codecFor(path)`, then mutate (unchanged).
2. **Plan the library**: `const lib = tableLibraryService.planTableWrites(modelFiles, layerFolder)`.
3. **Render** the primary with `resolver = lib.plan ?? libraryResolver()`. For `otherDomains`, `rewriteOtherSubjectAreas` becomes codec-aware: it lists `.json` **and** `.dbml` diagrams, parses each from its open document or disk, runs the same v5 callback (`renameTableInSubjectArea` works unchanged), and renders with the resolver.
4. **Settle pass**: every other DBML diagram (not the primary, not already in `otherDomains`) gets a no-mutation re-render with `refreshRelationshipsUses: true` and the plan's `pathChanged` when it has a member in a folder from `lib.plan.createdRelationshipsFiles`, or a member in `lib.plan.pathChanged`. Its writes are included when the text changed. This keeps `use` lines valid project-wide inside the same WorkspaceEdit.
5. **Dirty check**: refuse by name (`EditRefused`) when **any** path in the combined `FileWrite[]` is open with unsaved changes. This replaces `dirtyTableFile`.
6. **One WorkspaceEdit, applied by `applyFileWrites`** (D23, `src/providers/applyFileWrites.ts`). Before building it, the helper records the text of every path it will replace or delete (document text, else disk). Order:
   - the primary full-range replace first (always, for undo grouping, the existing `:2228` rationale; it is a text edit, so it fails only with the whole edit);
   - then every create, **relationships files before table files before layout files**: `createFile(uri, {overwrite:false, contents})`, after `ensureDir` for library paths only (§5.1);
   - then every other replace: `openTextDocument` + a full-range replace;
   - then every delete: `deleteFile(uri, {ignoreIfNotExists:true})`.
7. **When `applyEdit` returns `false`** the helper reconciles, because VS Code keeps what ran before a failing resource step:
   - a planned create whose file exists with exactly the planned bytes is deleted; one that is absent or differs is left alone;
   - a planned delete whose file is gone is re-created with the recorded text;
   - a replaced document whose text equals the planned text is set back to the recorded text with one **text-only** WorkspaceEdit (all-or-nothing) and saved only if it was saved before;
   - the reconcile itself is one WorkspaceEdit through the same helper. If it fails too, a modal lists every file it could not put back and says "Restore these from source control"; nothing is retried.
   - Then the usual `EditRefused` toast: "The edit could not be applied; nothing was changed." (or the modal's list).
8. **After `applyEdit` succeeds**: save the primary, then `saveDocumentByUri` for every replaced path. Record `ownWriteTracker.recordWrite` for every replaced or created path and `recordDelete` for every deleted path, **after** the bytes land. Add every replaced path, layout files included, to `editedTablePaths`.
9. **Refresh** as today. Other panels are refreshed by **diagram** URI; a layout path maps to its diagram with `diagramPathOfLayout`.

The YAML path keeps its existing WorkspaceEdit shape when it has no creates or deletes; when it has (a rename's create plus delete), it goes through `applyFileWrites` too, which is the same order it uses today plus the reconcile.

**Handler categories on a DBML diagram:**

| Handler(s) | Effect (all in the one WorkspaceEdit) |
|---|---|
| addColumn, updateColumn, removeColumn, toggleColumnKey, reorderColumns, rationale, description, grain, alias, meta, role (`applyTableEdit`) | Splice the table file. The primary replace is identical text. `updateColumn` / `removeColumn` relationship cascades re-render the owners' relationships files. |
| addRelationship, updateRelationship, editRelationship, removeRelationship(s), Turn Round (`commitRelationshipWrite`) | `home = 'library'` is **forced** when the doc is DBML (`:3835`). `plan.domainRelationships` must be `[]` (asserted). `plan.changed` owners go into their folder's relationships file. |
| addModel, addExistingModel, addExistingModels, addModelsFromDbt (`applyDbtModels`) | New table files (always DBML on a DBML diagram, D20; a name `_relationships` refused, §2.1), plus `use` lines (resolver sees the pending creates), relationships `use` lines and positions in the layout. `routeAddedRelationships(...).kept` is `[]` for DBML (`:1948`): everything routes to the library. Adding an existing YAML table is refused (D20), and so is a routed relationship from a DBML owner to a YAML table. |
| renameModel | Table file create + delete with a header splice. The ops' `delete: [old]` is folded into the rename (§4.6 step 0). The owner's Refs are re-spelled, and the `pointingAtIt` owners' Refs re-resolved. `use` lines change in this diagram, `otherDomains` and every relationships file, and so do the layout position keys. |
| removeModel(s) | The `use` line and positions are removed, `linkedModel` is pruned, and the relationships `use` line goes when it is no longer needed. The optional "Delete Table File" follow-up runs the D16 cascade as its own WorkspaceEdit (its own undo step, as today). |
| updatePositions, addAnnotation, updateAnnotation, removeAnnotation(s) | Notes in the `.dbml` and/or the layout file. A drag changes only the layout, and the primary replace is identical. |
| `ready` load persistence (`autoPositionNewTables`) | Writes the layout only, and only for a partially positioned diagram (unchanged rule). |
| undo / redo | `flushUndoRedo` saves `editedTablePaths`. The model-file test `/\.ya?ml$/` (`:2405`) becomes `/\.(ya?ml\|dbml\|dbdiagram)$/`. |

**Other provider changes:**

- **`isSubjectAreaV5`** and every other `detectSubjectAreaFormat` call site need no change: the codec's object is a plain v5 document (D8). A test runs each of the listed call sites' paths on a DBML doc and asserts `v5`, never `hybrid`.
- **`relationshipsInLibrary`** returns true for DBML docs.
- **The import banner** (§2.5): when the reading has declared Tables and no table `use` lines, the provider posts `dbmlEmbeddedTables` (a new message type with a sender, a handler and payload validation, as every message needs) and the webview shows "This file holds its own tables. **Import these tables…**", whose button posts `importEmbeddedTables` back; the handler runs Import DBML on the diagram file.
- **`recordCanvasOpen`** must not `JSON.parse` a `.dbml`. It records format `'v5'` plus `recordFeatureOnce('dbmlProject')`.
- **`handleGenerateSyncPlan`** reads `parsed.domain` / `parsed.layer` from the codec object (filled per §2.5).
- **`NON_MUTATION_TYPES`** does not change.
- **The change listener** (`:1793-1817`) treats a layout path in `editedTablePaths` like any library doc for the native undo flush.

### 5.4 Watchers (`src/watchers/FileWatcherService.ts`)

- **The semantic watcher** glob becomes `${semanticDir}/**/*.{json,dbml,dbdiagram}`. Each event is classified with `classifySemanticFile`:
  - **`diagram`**: the existing domain events;
  - **`layout`**: mapped to its diagram's URI as a `changed` event, skipped on own writes;
  - **`table`**: **ignored here**; the table watcher alone handles table files, so one change raises one table event;
  - **`relationships`**: a new event `onRelationshipsChanged(path)`. It invalidates the relationships cache and refreshes every open panel (every panel: a misplaced Ref can attach to any member, §2.4). It never calls `onTableChanged('_relationships')`;
  - **`other`**: ignored. A deleted table or relationships file never raises the "Subject area file deleted" toast (`extension.ts:1281`).
- **The table watcher** glob becomes `{logical-models,tables}/**/*.{yml,dbml}`, skipping relationships files. The name is the listed stem.
- **Foreign-format writes.** In a project whose storage is `dbml`, a **create** of a `.yml` table or a `.json` diagram that is not an own write shows one toast per session: "A YAML/JSON file was just added to this DBML project (<file>), probably by an AI helper set up before ERD Studio 2.0. Update the AI helper files so it writes DBML?", with [Update AI Helper Files] (runs the existing harness update for every outdated target) and [Not Now]. It never converts or deletes the file. Telemetry: the feature `dbmlForeignFormatWarned`.

### 5.5 Discovery, trees and decorations

- **`SubjectAreaService.listSubjectAreas`**:
  - lists `*.json` and `*.dbml` diagrams through the classifier;
  - `SubjectAreaSummary` gains `storage: 'json' | 'dbml'` (additive) and `conflict?: true` when the same stem exists in both formats in one layer;
  - `domain` is the stem;
  - the tree shows both with a "(JSON)" / "(DBML)" description only when they conflict.
- **`getSubjectArea`** dispatches by extension. For DBML it reads the diagram and layout from disk, calls `parseSubjectAreaDbml`, then `buildUnifiedSubjectArea` with `getModel` from `TableLibraryService` (relationships attached, §5.1).
- **`DomainTreeProvider`** needs no logic change. **`SemanticFileDecorationProvider`** decorates `diagram` only.
- **`ModelLibraryTreeProvider`**:
  - entries show their storage only when the project is `mixed`;
  - the open command for `.dbml` is `vscode.openWith(uri, 'default')`;
  - library folder labels name the real root (`tables`, or `logical-models` for v5);
  - the usage map uses `subjectAreaTableNames`.
- **`LayerService.detectLayersFromFilesystem`** is fixed by §3.3. **`addLayer`** keeps refusing `tables` and also refuses a name starting with `_`.

### 5.6 Activation, context keys and `package.json`

- **`refreshContextKeys`** (`extension.ts:1090`):
  - `erdStudio.storage` = `projectStorageOf()`;
  - `hasLogicalModelsDir` = `dirExists() || writesTableNaming() || storage !== 'yaml'`.
- **`package.json`:**
  - `customEditors[0].selector` adds `{ "filenamePattern": "**/.erd-studio/*/*.dbml" }`;
  - the new command `erdStudio.convertProjectToDbml`, title "Convert Project to DBML", category "ERD Studio", shown in the palette when `erdStudio.hasSemanticDir && erdStudio.storage != dbml`, and in the Table Library `view/title` `…` menu;
  - the `when` clause of `erdStudio.migrateToTableNaming` and `erdStudio.moveRelationshipsToLibrary` gains `&& erdStudio.storage != dbml`;
  - `contributes.languages` gains `{ "id": "json", "extensions": [".dbdiagram"] }`, so a layout file opens as JSON (no new language, no grammar);
  - `jsonValidation` and `yamlValidation` are unchanged.
- **`NO_LEGACY_ALIAS`** (`src/extension.ts:461`) gains `erdStudio.convertProjectToDbml`.
- There are still no writes on activation. The Convert offer is a prompt only (§6.4).

### 5.7 Create, rename, delete, import and other paths

| Path | DBML behaviour (when `writesDbml(projectStorageOf())`) |
|---|---|
| `createDomain` (`extension.ts:1889`) | Writes `<layer>/<slug>.dbml` from `renderNewSubjectAreaDbml({domain: slug, description, modelFolder})` with the `wx` flag, and `layers.json` when it is missing. No layout file. `subjectAreasCreatedHere` tracks the `.dbml`. Before writing, the slug is refused if `<slug>.json` or `<slug>.dbml` exists. |
| `setupSemanticDirectory` (`:2287`) | Creates `layers.json` only. `tables/` is created with the first table. |
| `renameDomain` (`:2077`) | Through `applyFileWrites`: `create(<new>.dbml)` whose text is `editSubjectAreaDbml(old, {after.domain = new})` (no hand splice, §4.5) + `delete(<old>.dbml)` + `create(<new>.dbdiagram)` / `delete(<old>.dbdiagram)` when it exists. Relative `use` paths stay valid (same folder). The new slug is checked against both extensions. |
| `deleteDomain` (`:2032`) | Deletes the `.dbml` and its `.dbdiagram`, with `recordDelete` for both. |
| `deleteLogicalModel` (`:1527`) | D16 cascade as one WorkspaceEdit (`applyFileWrites`) built from `planDbmlLibraryWrites({delete:[name], save: owners filtered by the new pure helper dropRelationshipsTo(models, name)})` plus a codec re-render of every diagram that uses it (`removeTableFromSubjectArea`, reusing `pruneViewConfigForRemovedTables`). The confirm text: "This removes the table's file, its N relationships and its place in M diagrams." The YAML path keeps today's behaviour and text, made format-neutral ("removes the table's file"). |
| `organizeModelLibrary` (`:1551`, `modelLibraryOrganizer.ts`) | A DBML table move is `planDbmlLibraryWrites({move})` + a settle re-render of the diagrams that use it, in one WorkspaceEdit (`applyFileWrites`, not a bare `renameFile`). Its Refs move verbatim (§4.6 step 3). A YAML move is unchanged. Extensions are kept. |
| `resolveDuplicateModel` (`:1629`, `duplicateModelResolver.ts`) | For a DBML copy: `planDbmlLibraryWrites` with a rename op for **that copy** (the snapshot's entry is the copy, not the winner), so the text comes from `editTableDbml(copyText, …, {rename: true})` and no caller splices by hand; delete the old copy; and repoint only the diagrams whose `use` line resolves to **that copy's path** (codec render with an overridden resolver and the copy in `pathChanged`) and their layout keys. Refs naming the old spelling stay with the remaining copy. |
| `newSubjectAreaWriter.ts` (Draw from dbt, Import DBML, Open Example) | `documentText` is replaced by a storage-aware `buildNewSubjectArea(storage)`. For DBML it returns the diagram text, layout text (positions and sticky layouts, present only when any exist), table writes and relationships-file writes, all from `planDbmlLibraryWrites` on a snapshot, **plus the settle re-render** of every other DBML diagram that has a member in a folder whose relationships file the plan creates (as §5.3 step 4). It applies them with `writeFilesWithRollback` (`wx` for new files), which restores a **snapshot** of every file written on failure. It no longer rolls back through `deleteTable(name)` (`newSubjectAreaWriter.ts:131`), which for DBML is the D16 cascade and would edit other owners' files. `changedTables` / `routeToLibrary` / `planDbmlImport.changedLibraryTables` feed `save` ops. `usesLibraryRelationships` is true. |
| `drawFromDbt.ts`, `importDbml.ts`, `openExampleDiagram.ts` | The path is `<layer>/<slug>.dbml` (`freeSubjectAreaSlug` checks both extensions). Import writes the source `.dbdiagram` positions and sticky layouts into the new layout file. Existing **YAML** library tables matched by name are skipped with the reason "a YAML table can't join a DBML diagram; convert the project first" (D20). A model named `_relationships` is skipped with the §2.1 reason. |
| `dbmlImportParse.ts` (`readDbml`) | `Parser.parse` rejects `use`. Before parsing, Import DBML checks for a `use` declaration (a line starting `use ` outside a comment or string) and refuses with: "This DBML file imports other files (`use`), so it is part of a multi-file project, such as another ERD Studio 2.0 project. Import reads one self-contained file: open that project's diagram in ERD Studio and use **Export Diagram… → DBML (rich)**, then import the exported file." Telemetry: `importDbmlInvalid` (existing). |
| `exportDiagram.ts`, `exportAllDiagrams.ts` | A Save As target **inside the semantic dir** is refused in every project ("Save the export outside .erd-studio/: files there are your diagrams' own storage"), and the default Save As folder becomes the workspace root when `defaultSaveFolder` is unset and the diagram is in the semantic dir (it was `path.dirname(domainPath)`, `exportDiagram.ts:323`). This keeps an export from overwriting `<layer>/<name>.dbml` and its `.dbdiagram`, or appearing as a diagram. |
| `moveRelationshipsToLibrary.ts` | Hidden by `when` in DBML projects. If invoked anyway: "Nothing to move: relationships in a DBML project are already in the table library." In a mixed project its writes to DBML owners go through `planDbmlLibraryWrites`, applied with `writeFilesWithRollback`. |
| `migrateNaming.ts`, `namingMigrationFiles.ts` | The input reader keeps only `.json` diagrams and `.yml` tables (DBML texts are never fed to `planNamingMigration`). The editor offer (`maybeOfferNamingMigration`) is skipped when storage ≠ `yaml` or the DBML offer is eligible (§6.4). |
| `syncPlanBuilder.ts:233` | Option `newTableFilePath(name): string`. The host passes `tableLibraryService.pathForNewTable`, so a DBML project gets `tables/[folder/]<m>.dbml`. `modelContext[m].relationshipsPath?` is added (additive) from `relationshipsFileFor`. |
| `physicalTooling.ts:37` | Excludes the configured `semanticDir` (not only the literal `.erd-studio`) from the `*.dbml` physical-tool marker search. |
| `payloadValidation.ts` | New `validateNewDbmlTableName(name)` (safety plus the reserved name, §2.1), called only by the create handlers (add, add existing, add from dbt, rename's new name) when the table will be DBML. `validateTableNameSafety` is unchanged. |

### 5.8 Undo

- Canvas edits: unchanged mechanism. Every replaced path, the layout included, is in `editedTablePaths`. **Verify in the dev host** (S5) that Cmd+Z and the toolbar Undo rewind a drag (a layout-only change) and a relationship edit (a relationships file plus a table).
- If a layout-only edit does not undo, the fallback is: `handleUndoRedo` and the native-undo listener also run `undo` / `redo` against the layout document of the panel's diagram whenever the last edit for that panel touched only the layout. Track this as `lastEditLayoutOnly` per panel, set in `applySubjectAreaEdit` when every non-primary write is the layout and the primary text is unchanged. Record the outcome in the PR.
- File operations (create, delete, rename) take part in VS Code's workspace undo while the editor stays open, as the naming migration already relies on. Messages never promise more than that.

### 5.9 Custom-editor reroute

In `resolveCustomTextEditor(document, panel)`, when `document.uri.scheme === 'file'`, `document.uri.fsPath` ends in `.dbml` and `classifySemanticFile(rel, …).kind !== 'diagram'`. Any other scheme (`git:` in the SCM diff, the merge editor's inputs) is **never** rerouted: disposing that panel would break the diff and merge views of `tables/_relationships.dbml`, the file most likely to conflict. Such a document gets the not-a-domain page with the **Open as Text** button instead (below).

```ts
const column = panel.viewColumn;
panel.dispose();
await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { viewColumn: column, preview: false });
return;
```

**Verify in the dev host** (S4) by double-clicking `tables/x.dbml` and `tables/_relationships.dbml` in the Explorer, and by opening each from the Source Control view's diff and from a merge conflict in the merge editor. If a blank tab or flicker remains, fall back to the existing not-a-domain page (`SemanticEditorProvider.ts:2862-2875`) with one button, **Open as Text**, which runs the same `openWith`. Record the outcome in the PR.

---

## 6. Migration: Convert Project to DBML

### 6.1 Pure planner

`src/services/dbmlConversion.ts` (vscode-free, CLI-bundled):

```ts
export interface DbmlConversionInput {        // read by dbmlConversionFiles.ts (fs only, CLI-safe; generalises readNamingMigrationInput)
  semanticDir: string;
  layers: string[];                           // layer ids (layers.json or defaults)
  tablesDirIsLayer: boolean;
  /** Every file under the semantic dir the classifier names (§3.5), with its text (BOM stripped, `hadBom` kept):
   *  .yml tables, .json diagrams, and in a mixed or half-converted project the .dbml tables, relationships files,
   *  .dbml diagrams and .dbdiagram layouts already there. The listing is also the resolver of the self-check. */
  files: Array<{ path: string; text: string; hadBom: boolean; kind: SemanticFileKind; storage?: 'yaml' | 'json' | 'dbml' }>;
}
export interface DbmlConversionPlan {
  creates: Array<{ path: string; text: string }>;   // tables, relationships files, diagrams, layout files
  replaces: Array<{ path: string; text: string }>;  // existing relationships files and DBML diagrams that gain Refs or use lines (mixed projects)
  deletes: string[];                                 // every converted .yml and .json
  resumed: string[];                                 // targets already on disk with exactly the planned bytes (a half-applied earlier run): neither created nor refused
  refusals: string[];                                // non-empty → nothing is written
  notes: string[];                                   // lossy-but-kept items, behaviour changes
  v4SubjectAreas: string[];                          // need the v4 → v5 step first
  movedRelationships: Array<{ from: string; to: string; diagrams: string[] }>; // diagram-held → library, and where they now also draw
  summary: { tables: number; diagrams: number; relationshipsFiles: number; relationships: number };
}
export function planDbmlConversion(input: DbmlConversionInput): DbmlConversionPlan;
export function describeDbmlConversion(plan: DbmlConversionPlan): string;   // shared by the modal and doctor
```

**Refusals** (each names the files involved):

- `tables/` is a layer (§3.3);
- a table named `_relationships` (in any format, §2.1);
- a name in both `logical-models/` and `tables/`, the same name in two library folders, or a case clash in the library (Convert never picks a copy; the duplicate resolver does, §5.7);
- a `.yml` that does not parse or has duplicate keys;
- a `.json` diagram that is hybrid or legacy;
- a target `.dbml` or `.dbdiagram` that already exists **with different bytes** from the plan's (the same bytes are `resumed`); for a relationships file or a DBML diagram that exists, the plan **replaces** it instead (below);
- `x.json` and `x.dbml` in one layer, unless `x.dbml` holds exactly the bytes the plan would write for `x.json` (a resume);
- relationships that diagrams define differently (`planMoveToLibrary` / `resolveConflict` conflicts);
- a composite group whose members disagree on **target or cardinality** (role disagreements are not refused: §2.8, first member's role, with a note);
- a relationship whose two ends are the same columns;
- a diagram whose `layer` key disagrees with its folder;
- an existing DBML file the plan must edit that the reader marks unreadable or `writable: false`;
- **any self-check failure** (step 7), as a named refusal, never a generic "bug" message.

Two relationships joining the same column sets are **not** refused: they are deduped (step 3). v4 diagrams are **not** refused by the planner. They are returned in `v4SubjectAreas`, and the command chains `migrateToV5` first, exactly like `migrateNaming.ts:285-290`. `doctor` says "run the v4 → v5 step first (the command does it for you)".

**The planner, step by step:**

1. Parse every yml with `parseTableText` (duplicateKeys `'last'` refused). Parse every JSON diagram with `parseSubjectAreaJson` + `validateSubjectAreaDocument`. Read every existing DBML file with the subpath readers.
2. Fold the relationships held in diagram files into owner tables with the existing pure `planMoveToLibrary` semantics. Record `movedRelationships`, with the other diagrams where each will now also draw, as a note.
3. **Normalise the relationships** so the output is valid DBML, each with a note naming the file and the relationship:
   - **respell** every end to the real table spelling **and the real column spelling** (`resolve().columns`), so `Mentor_ID` / `EMPLOYEE_ID` in `packages/core/test/fixtures/composite-and-self/.erd-studio/logical-models/gold/employee.yml` become the declared column names (the raw spelling fails `[4000]` in all three parsers, verified);
   - **dedupe** a link stored twice (in both ends' files, or twice in one, either way round, `-` and `<>` included: `[5001]` otherwise, verified) with the `mergeLibraryRelationships` ranking (`domain.ts:770-797`), the copy it already draws;
   - **canonicalise** library `one-to-many` entries (`canonicalRelationship`);
   - a composite group whose roles disagree takes its first member's role (`assembleGroups`, `domain.ts:894-899`);
   - a **dangling** relationship (target table without a file, or target column gone) is written as a commented line under a one-line explanation in the owner's relationships file, `// Kept by Convert Project to DBML: dim_x has no table file, so this relationship is not active.` then `// Ref: fct.x_key >? dim_x.x_key`, never as a live Ref (it would fail `[4000]` and break the whole file).
4. **Tables:**
   - `logical-models/[f/]x.yml` and `tables/[f/]x.yml` → `tables/[f/]x.dbml` via `renderNewTableDbml`, the folder kept;
   - comments, unknown keys and alias anchors, found from the YAML `Document`, are prefixed as the §2.8 comment block and get a note each.
5. **Relationships** go through **`planDbmlLibraryWrites`** (§4.6) on a snapshot of the project **as it will be after the table writes**, with a `save` op for every owner. For a folder whose `_relationships.dbml` already exists (a mixed project), that is a `replace` built by `editRelationshipsDbml(oldText, …)`; otherwise a `create`. Its cross-file duplicate check runs over the existing DBML Refs too. No Convert code calls `editRelationshipsDbml` directly.
6. **Diagrams:**
   - `{layer}/x.json` → `{layer}/x.dbml` via `renderNewSubjectAreaDbml`, plus `x.dbdiagram` when positions or sticky layouts exist;
   - a second or later sticky note with an id already used in that diagram gets a new UUID, with a note (`[3003]` otherwise, verified);
   - unknown JSON keys are carried as the comment block plus a note;
   - every **existing DBML diagram** gets a settle re-render (`editSubjectAreaDbml` with `refreshRelationshipsUses: true`, no mutation) and is a `replace` when the text changed: it needs the `use` lines of relationships files this run creates.
7. **Deletes:** every converted file. `layers.json` and `templates/` are untouched. Order and resume: a target already on disk with exactly the planned bytes moves to `resumed` (no create); a source `.yml`/`.json` whose target is `resumed` is still deleted.
8. **Self-check before returning:**
   - `compileDbmlProject` (virtual root, §4.1) over every DBML file of the project **after** the plan (created, replaced and untouched) must report **no** errors with the bundled 11.0.0. (Portability to 9.x and 10.x is not checked at run time, where only one parser is bundled: it follows from the writer quoting every value, and the multi-parser tests and `scripts/e2e-dbml.mjs` prove it.) A diagnostic becomes the named refusal "Convert would write DBML that does not compile: <file>:<line> <diagnostic>. Nothing was changed; please report this with the file." (the probe cases above are handled before this, so it should not fire);
   - for each diagram, `normaliseForStorageEquivalence(display after, {convert: true})` must equal `normaliseForStorageEquivalence(display before, {convert: true})`, apart from the documented `movedRelationships`, or the planner refuses, naming the diagram and the first difference. Both displays are built with `loadDisplaySubjectArea` over the in-memory files with a `readFile` that **resolves table names from the input listing** (the host's semantics, §3.4), never through core's layer-folder probe, so a library folder that is not a layer gives no false refusal.

   This is the guarantee "nothing that matters dropped".

### 6.2 Command (`src/commands/convertProjectToDbml.ts`)

The command copies `migrateNaming.ts` step by step:

1. Read the input and plan.
2. v4 present → confirm and chain `migrateToV5`, then re-read.
3. Refusals → a modal listing them, and stop. Telemetry `convertToDbmlRefused`.
4. Nothing to convert (storage already `dbml` and no creates, replaces or deletes) → "This project is already stored as DBML."
5. Dirty files → refuse by name.
6. Modal confirm with `describeDbmlConversion`. It includes:
   - "Everyone who opens this project needs ERD Studio 2.0 or later. Older versions show no diagrams, and AI helper files from before 2.0 write YAML: update them afterwards (ERD Studio: Set Up My AI Helper)." (the naming migration's teammate warning, `SemanticEditorProvider.ts:2078-2080`, is the precedent);
   - "Git will show the converted files as new files, because their content changes completely, so their history does not follow them. Commit your work first.";
   - "Relationships kept in diagram files move to the table library and will also show in these diagrams: …";
   - when `resumed` is non-empty: "An earlier conversion stopped part way; this finishes it.";
   - "Undo: Edit > Undo while VS Code stays open, or restore from source control."

   Cancel → telemetry `convertToDbmlCancelled`.
7. Re-plan after the dialog and compare `describe` (#219 pattern).
8. Build the writes: creates (relationships files first, then tables, then diagrams, then layout files), then replaces, then deletes (D23). Create folders only once the writes are built.
9. `holdRefreshes`, then **`applyFileWrites`** (§5.3), which reconciles on `false` (deletes the creates that landed, re-creates the deletes, puts back replaced documents) so a failed run leaves the project as it was; when even the reconcile fails, its modal names the files and `doctor`'s `finish-dbml-conversion` step (§6.5) picks the run up again. Record ownWrites after it applies. The bug in `migrateNaming.ts:383-385` ("Nothing landed") is fixed the same way in this PR, since it shares the helper.
10. Remove emptied `logical-models/` (and its folders). `tables/` is kept.
11. Close open `.json` canvas tabs of converted diagrams (`vscode.window.tabGroups`) and reopen their `.dbml` with the custom editor.
12. `invalidateCache`, refresh the context keys and trees.
13. Telemetry: `convertToDbml` on success. On failure, `convertToDbmlFailed`, and the raw exception is never shown.

### 6.3 What happens to diagram-held relationships

They become library Refs owned by their FK table (`canonicalRelationship`), in that table's folder file. This is the existing "Move to library" semantics, now unavoidable: a library relationship draws in **every** diagram that has both ends (`domain.ts:796`). Both the plan and the `doctor` preview list each moved relationship and the extra diagrams it will appear in, and conflicting copies are a refusal.

### 6.4 The offer

`maybeOfferDbmlConversion` (provider) is wired by `setDbmlConversion` (`extension.ts`, beside `setNamingMigration :1429`).

- **When it shows:** on a canvas open, when storage is `yaml` or `mixed`, no refusal exists, and the workspaceState key `erdStudio.dbmlConversionDeclined` is unset.
- **What it shows:** a non-modal notification with [Convert…] [Not now] [Don't ask again]:
  - `yaml`: "This project is stored as YAML and JSON. ERD Studio 2.0 stores projects as DBML, an open format. Everyone who opens it will need ERD Studio 2.0 or later afterwards. Convert now? (You'll see the full list of changes first.)";
  - `mixed`: "This project is stored as DBML, but N files are YAML or JSON (probably written by an AI helper set up before 2.0). Convert them to DBML? (You'll see the full list first.)".
- **Ordering:** it shows **before** the naming offer, and the naming offer is not shown in a session where the DBML offer was eligible. There is one prompt per canvas open.
- **Telemetry:** `convertToDbmlOffered`, `convertToDbmlDeclined` (Don't ask again) and `convertToDbmlNotNow`.

### 6.5 `doctor` preview

`erd.dbmlConversion` is present when storage ≠ `dbml`:

```json
{ "tables": 9, "diagrams": 6, "relationshipsFiles": 1, "relationships": 14, "v4SubjectAreas": ["gold/finance.json"], "movedRelationships": [...], "refusals": [], "notes": [], "preview": "<describeDbmlConversion text>" }
```

It is a preview, not a next step, as `namingMigration` is. `erd.namingMigration` is emitted only when storage is `yaml` (unchanged condition otherwise).

One exception is a next step: when the plan has `resumed` entries, or a source `.yml`/`.json` sits beside its converted `.dbml` target, `doctor` raises **`finish-dbml-conversion`** ("A conversion to DBML stopped part way. Run ERD Studio: Convert Project to DBML again to finish it; it checks every file first."), `command: 'erdStudio.convertProjectToDbml'`.

---

## 7. CLI, MCP server, harness, schemas, telemetry, build

### 7.1 CLI (`src/cli/`)

Every JSON change is additive.

**`doctor` (`doctor.ts:276-330`, `format.ts`):**

- **`erd.storage`**: `'dbml' | 'yaml' | 'mixed'`, defaulting to `'dbml'` when no `.erd-studio` exists. `erd.naming` is kept, and the docs say to ignore it when storage is `dbml`.
- **Diagram listing**: per-diagram `format` comes from the classifier. `parseSubjectAreaJson` / `detectSubjectAreaFormat` run only for `.json`; a `.dbml` is read with `parseSubjectAreaDbml`.
- **Merge-conflict markers** are detected in `.dbml` and `.dbdiagram` files as well. Such a file's problem carries `mergeConflict: true`, and **every** conflicted DBML or layout file (table, relationships, diagram, `.dbdiagram`) is routed to `resolve-merge-conflicts`, never to `fix-dbml-file`: assistants rely on that flag to never pick a side (`harnessService.ts:307`).
- **`erd.dbmlProblems`**: `[{file, line, column, code, severity, message, mergeConflict?}]`, built from:
  - `compileDbmlProject` (the bundled 11.0.0, virtual root) over every diagram, with its imports;
  - each relationships file on its own;
  - each table file on its own;
  - ERD Studio's own checks, each with a **fixed severity** and, where it is a missing or wrong line, the **exact line to add** in the message:

    | Check (code) | Severity | Why |
    |---|---|---|
    | file does not parse / is invalid (the parser's code; `3025`/`3075` in a table file and `3051`/`3063` in a diagram with the "quote the value" hint, 11.0.0 numbering) | error | ERD Studio cannot read it |
    | an unquoted number or boolean custom value, `natural_key: true` / `scd_type: 2` (`unquotedValue`) | warning, with the quoted line | ERD Studio (11.0.0) reads it, but DBML 9.x and 10.x tools reject the whole file and every diagram that imports it; the message gives the quoted form (`natural_key: 'true'`). The writer keeps it until that value is edited. |
    | merge conflict | error, `mergeConflict: true` | routed to `resolve-merge-conflicts` |
    | `inlineRefInTableFile`, `useInTableFile`, `refInTableFile` | error | the file breaks in every other DBML tool and ERD Studio refuses to write it (§2.2) |
    | duplicate Enum name across table files (`duplicateEnum`) | warning | ERD Studio writes selective `use` lines, so only hand-written `use *` lines are affected; named so they can be changed |
    | same link in two relationships files or twice in one (`duplicateRef`) | error | `[5001]` in every DBML tool (§2.4) |
    | relationships file missing a `use` line its Refs need (`missingUse`) | warning, with the line | ERD Studio reads it anyway and adds the line on its next write to that Ref |
    | diagram missing a relationships `use` line (`missingRelationshipsUse`) | warning, with the line | only other DBML tools lose the Refs |
    | misplaced Ref (`misplacedRef`) | warning, with the target file | drawn; moved home by the next write that changes the owner's relationships, name or folder |
    | orphaned Ref (owner is YAML or unknown) | warning | |
    | dangling Ref | warning | |
    | `use` path that does not point at the resolved file, or differs in case (`usePathMismatch`) | warning, with the corrected line | read by name; rewritten on the next edit |
    | table file stem and declared name differ in case (`nameCaseDrift`) | warning | readable everywhere, but `git mv` it to match |
    | unsorted `use` lines or Refs | not reported | cosmetic |
    | a project path or `.erd-studio` path containing a space (`pathWithSpace`) | warning | "DBML 10.x drops imported tables when a folder in the path has a space; 9.1 and 11+ do not. ERD Studio is not affected." (A dbt-derived table name can hold a space, since only names created in ERD Studio follow `TABLE_NAME_PATTERN`, so this also covers table file names.) |
    | a table in both formats | error | routed to `resolve-format-conflicts` |
    | `tables` listed as a layer, or `.json` in the DBML `tables/` (`tablesLayerConflict`) | error | §3.3 |
    | DBML library with no `layers.json` (`missingLayersConfig`) | warning | §3.3 |
    | `.dbml` diagram in a YAML project (`dbmlDiagramInYamlProject`) | warning | §3.2 |
    | Table / Ref / TableGroup declared inside a diagram | warning | |
    | diagram declaring Tables with no table `use` lines | warning | routed to `import-dbml-file` |
- **`dataTypeAliasColumns`** skips `.dbml`.
- **`erd.dbmlConversion`**: §6.5.
- **New `nextSteps` ids:**
  - `fix-dbml-file` when any problem has severity **error** and no `mergeConflict`;
  - `resolve-format-conflicts` when the same table or diagram exists in both formats;
  - `finish-dbml-conversion` (§6.5);
  - `import-dbml-file` for each diagram that declares Tables and has no table `use` lines (§2.5): "Run ERD Studio: Import DBML… on <file>; it is a single-file DBML, not an ERD Studio diagram.";
  - warnings never raise a next step, so "run doctor until clean" loops end.
- **Existing `nextSteps` ids** keep their meaning, with format-aware `why` text: `fix-model-yaml` stays for YAML files. `turn-round-relationships` (`doctor.ts:531-533`) says "…in the relationships file of that column's table (`tables/<folder>/_relationships.dbml`)" when the owner is DBML, and keeps "in that column's table file" for YAML.
- **`update-harness`** is raised whenever **any** target in `harnessStatus()` is outdated (Claude, `.agents`, Copilot, Gemini, `AGENTS.md`), not only `harness.claude` (`doctor.ts:537`, `:656`, `:688`), and in every project. Its `why` names the stale targets and, when storage ≠ `yaml`, adds "an AI helper from before 2.0 writes YAML into this DBML project".
- **A newer harness marker** (a teammate on a later ERD Studio) is reported as the new `FileState` `'newer'`, never as `outdated`: `doctor` says "Update ERD Studio: these helper files are from a newer version", **Update All** never replaces a `'newer'` file, and `detectStale` lists only older markers. This also stops 2.0 from putting older text back over a newer teammate's files.
- **Human output** prints `storage DBML|YAML|mixed`, the DBML problems by severity, and the Convert preview.

**The other commands:**

- **`inventory`**:
  - `listSubjectAreaFiles` uses `subjectAreaTableNames`;
  - entries gain `format`;
  - `logicalTables[].file` may be `.dbml`, and the entries gain `format`.
- **`diff`** (`diff.ts`):
  - `fixesFromPlan` sends a missing table to `tableLibraryService.pathForNewTable(m)`;
  - relationship fixes (add, remove, cardinality) go to `relationshipsFileFor(fromTable)` for a DBML owner;
  - the v4 probe runs only for `.json`, and `'.json'` stripping (`diff.ts:495`) goes through `subjectAreaStorageOf`;
  - `describeSubjectAreaError` maps typed errors: `invalid-dbml` → the new code `dbml-invalid` with `file:line`; a newer `erd_schema_version` → `unsupported-format`; a `--domain` that classifies as a table, relationships file or layout → the new code `not-a-diagram`;
  - an unreadable `.dbml` table file gets the new FixKind **`fix-dbml-file`** (additive), never `fix-model-yaml` (`diff.ts:452`), and a conflicted one keeps the merge-conflict route;
  - every other Fix shape and kind is unchanged.
- **`export`**: `--domain` accepts `.dbml`. The usage examples in `args.ts:243-247` become `.erd-studio/gold/sales.dbml`, with `test/unit/cli.export.test.ts:129` updated.
- **`context.ts`** wires `projectStorageOf`.

**Bundling.** `cli.noVscode.test.ts` is **inverted**: `dist/cli.js` **must** contain `@dbml/parse`, resolved from the root `node_modules/@dbml/parse` (11.0.0, not the `dbml-parse-v9` / `-v10` test aliases), and still no `vscode` and no worker file. No `esbuild.js` change is needed: the CLI has no `external` and resolves the subpath through tsconfig paths.

### 7.2 MCP server (`mcp-server/`)

- `services.ts` builds the same three services, now with DBML support.
- **`read_domain.ts`** finds the diagram through `listSubjectAreas`, `.dbml` first, then `.json`, instead of building `${domain}.json`. Its `domain` argument and error text say "the diagram's file name without .dbml or .json".
- **`list_domains`** adds `file_format`. **`list_models`** adds `file_format`, and its description says the tables are `.dbml` in `tables/` (or older `.yml`). **`read_model`** says "file name without its extension".
- **`lib/setup.ts`** and **`get_editor_setup.ts`**: the stale command names become current ones ("ERD Studio: New Subject Area", "ERD Studio: Set Up My AI Helper").
- **`mcp-server/README.md`** says the model is stored as DBML, an open format, with YAML/JSON for projects from before 2.0.
- **`test-smoke.mjs`** adds checks against `test/fixtures/dbml-native`: list_domains, read_domain (relationships including composite, role, one-to-one and self-reference), list_models and read_model.
- **Build:** `mcp-server/tsconfig.json` gets the subpath path. No esbuild change is needed, because `@dbml/parse` is bundled from the root `node_modules` and CI already runs the root `npm ci`.

### 7.3 Harness (`src/services/harnessService.ts`; read `src/harness/CLAUDE.md` first)

**`HARNESS_VERSION` becomes `'35'`.**

**Where the text goes.** The generated schema `SKILL.md` is already 497 lines and 40.5 KB, so a DBML-first rewrite cannot also keep the full YAML rules inline under 500 lines. For the **`claude` and `agents` skill targets**, the content is split into the skill file plus **version-marked companion files** beside it, as `SYNC.md` already is: `SKILL.md` (what to write, layout, edit rules, routing), `DBML.md` (the DBML format in full) and `LEGACY.md` (today's complete YAML/JSON v5/v6 rules, **not condensed**: every existing project still needs the quoting, naming, folder and relationship rules). `SKILL.md` links both and says which to read from `erd.storage`. The **Copilot, Gemini and Codex single-file targets** keep the full text inline (they have no companion files). New tests cap each generated skill file at **500 lines and 48 KB**, and assert that each companion carries the version marker and is covered by `fileState` / `detectStale` / Update All like `SYNC.md`.

**`SCHEMA_CONTENT`** (now the source of all three parts) holds, in order:

1. **What to write.** Run `erd-studio doctor --json` and read `erd.storage`:
   - `dbml`, or no `.erd-studio` folder yet → write DBML (`DBML.md`);
   - `yaml` → follow `LEGACY.md`;
   - `mixed` → new tables and new diagrams are DBML; an existing file keeps its format; a JSON diagram may list DBML tables; a DBML diagram may list only DBML tables and a DBML table's Refs may name only DBML tables (D20); suggest **Convert Project to DBML** rather than converting by hand;
   - the doctor result has **no `erd.storage` field** (an ERD Studio CLI older than 2.0, perhaps a teammate's) → write what the files already are: if the project has `.dbml` table files, DBML; otherwise follow `LEGACY.md`, and tell the user their ERD Studio is older than these instructions;
   - **no CLI** (exit 127, which the setup skill already handles) → the same file rule: any `.erd-studio/**/*.dbml`, or no `.erd-studio` at all, means DBML; `.yml` tables or `.json` diagrams only means `LEGACY.md`.
2. **Layout.** The §2.1 tree, and "a new project also needs `.erd-studio/layers.json`" with its minimal content.
3. **Table file.** First rule: **quote every custom value, even `'true'` and numbers** (`natural_key: 'true'`, `scd_type: '2'`). ERD Studio reads an unquoted `true` or `2`, but DBML 9 and 10 tools reject the whole file, and an unquoted word or phrase (`role: fact`, `grain: one row`) is an error everywhere, ERD Studio included; `doctor` flags both. Project keys in a diagram are quoted too (`erd_schema_version: '7'`). Then the §2.2 rules and an example, including the placeholder, exact-case names, and "no `use`, no `Ref`, no inline `[ref: …]`: relationships go in the folder's `_relationships.dbml`".
4. **Field names.** The §2.2 mapping table, from `dbmlRichProperties`.
5. **Relationships file.** Ownership, the operator table (with the `?` marks), sorted Refs, the file's own `use { table x }` lines, "name a Ref only to give it a role; the name is shown on the line", composites, "one Ref per pair of column sets, in one file only", and a **warning** example: a one-to-one is written key end first, FK second (`Ref: dim.pk ?- fct.fk`); writing it FK first is read by keys and may be misread.
6. **Diagram.** The Project keys, table and relationships `use` lines (paths relative to the diagram file, not to `.erd-studio`), Notes, and the layout file (omit it for auto layout).
7. **Edit rules.** Edit in place and never reformat. Add a table = new file + a diagram `use` line (+ the relationships `use` line). Add a relationship = a Ref in the FK table's folder file + `use` lines. Never hand-merge a conflicted file. Check with `erd-studio doctor` and `erd-studio export --domain <file>.dbml`.
8. **Legacy YAML/JSON (projects before 2.0)** (`LEGACY.md`): today's text, complete, with "never convert by hand: run ERD Studio: Convert Project to DBML."
9. **The "DBML: import and export" section** is rewritten: storage is DBML, Export (`dbml-rich` + `.dbdiagram`) is the route to dbdiagram.io, Import reads one self-contained file (no `use`), and "YAML and JSON files stay the only storage" is deleted.

**Elsewhere in the harness:**

- **`SYNC_CONTENT`**: the logical-side actions get DBML versions (add column = a line in the Table block; relationship fixes = Ref lines in `relationshipsPath`), with the YAML ones kept under "legacy". It uses `modelContext[m].relationshipsPath` (§5.7).
- **Generator copy:**
  - the Claude skill description (`:755-764`) becomes "DBML tables, relationships and diagrams (YAML/JSON for older projects)";
  - the Copilot description (`:828`) changes to match;
  - the Gemini review rules (`:841-858`) gain DBML rules (quoted custom values, `use` lines, one Table per file), and the stale "Schema version must be 5" goes.
- **The setup skill** (`src/harness/claude/erd-studio-setup/`):
  - `SKILL.md` is at 498 of < 500 lines, so it **may only replace lines**. The replacements, by current line:
    - `:209-210` (merge conflicts): "…a `fix-model-yaml` or `fix-dbml-file` whose file entry has `mergeConflict: true`, or a `dbmlProblems` entry with `mergeConflict: true`, at any stage: git left two versions in a file.";
    - `:384`: "run `doctor` and fix each `fix-model-yaml` / `fix-dbml-file` file:line it lists first (usually a value to quote) —";
    - `:414`: "- **`fix-model-yaml` / `fix-dbml-file`** first, always: the file does not parse — fix that line (DBML: `references/troubleshooting.md`), re-run the diff (a merge conflict: Stage 1). `resolve-format-conflicts`, `finish-dbml-conversion` and `import-dbml-file`: `references/troubleshooting.md`.";
    - `:470`: "1. Glob `.erd-studio/*/*.{dbml,json}` and propose one domain (…)", the rest of the line unchanged;
    - a test asserts each new id (`fix-dbml-file`, `resolve-format-conflicts`, `finish-dbml-conversion`, `import-dbml-file`, and the CLI codes `dbml-invalid`, `not-a-diagram`) appears in `SKILL.md` or a reference it links;
  - `references/building-the-model.md` gets DBML "Which files to write", field-by-field and a worked example, with YAML as the legacy branch;
  - `references/without-dbt.md`:
    - `:53-56` (a new project): "A new project writes **DBML** (doctor's `erd.storage` says `dbml`): `.erd-studio/layers.json`, tables in `tables/`, diagrams in a layer folder";
    - `:67-71` (which `nextSteps` to handle): add `fix-dbml-file`, `resolve-format-conflicts`, `finish-dbml-conversion` and `import-dbml-file`, and read `erd.storage` instead of `erd.naming`;
    - route 2 (`:79-85`): the Glob becomes `**/*.dbml` **skipping `node_modules` and the ERD Studio folder** (`.erd-studio/` or the configured one), so a 2.0 project's own storage never triggers Import; "its own YAML and JSON stay the only copy" (`:85`) becomes "ERD Studio stores its own model as DBML too, split into one file per table"; "DBML is an open format" kept verbatim (`harnessAssets.test.ts:548`);
    - `doctor` / `export` checks on `.dbml`;
  - `references/verify-and-fix.md` gets a DBML translation per diff fix kind, with the fix ids unchanged, plus `fix-dbml-file`;
  - `references/modelling-approaches.md` and `metadata.md`: format-neutral field names (or both spellings);
  - `references/troubleshooting.md`: DBML parse errors (with the "quote the value" fix), the new next-step ids, and "a conflicted `_relationships.dbml`: keep both sides' Ref lines and both sides' `use` lines, then run doctor; a Ref that appears twice is reported".
- **`layers.json`.** The harness's new-project instructions (above, item 2) and `references/without-dbt.md` tell the assistant to write `layers.json` first; `doctor` warns `missingLayersConfig` (§7.1).
- **Regenerate the fixtures in this PR:**

  ```
  npx esbuild scripts/regen-fixtures.ts --bundle --platform=node --format=cjs --loader:.md=text --outfile=scripts/.regen-fixtures.cjs && node scripts/.regen-fixtures.cjs && rm scripts/.regen-fixtures.cjs
  ```

  This rewrites `test/fixtures/dbt-project/.claude/skills/erd-studio/{SKILL.md,SYNC.md}` and adds `DBML.md` and `LEGACY.md` beside them. Check `git diff --stat test/fixtures`.
- **Also update** `docs/semantic-domain-json-reference.md` (S9) and `src/harness/CLAUDE.md:7-8`. listSubjectAreas now reads `.json` and `.dbml`.

### 7.4 Telemetry (D21)

These are appended, in this order, to **both** `src/services/telemetryPayload.ts` and `telemetry/src/index.js`, and documented in `telemetry.json`:

- **`ERROR_CODES` additions:** `modelFileDbmlSyntax`, `modelFileDbmlInvalid`, `modelFileDbmlStructure`, `domainLoadDbml`, `convertToDbmlFailed`.
- **`FEATURES` additions:** `dbmlProject` (presence, `recordFeatureOnce`), `convertToDbml`, `convertToDbmlOffered`, `convertToDbmlDeclined`, `convertToDbmlNotNow`, `convertToDbmlCancelled`, `convertToDbmlRefused`, `dbmlForeignFormatWarned`. (The Move Relationships keys `relMoveNotNow` / `relMoveCancelled` are the precedent.) The order test in `test/unit/telemetryPayload.test.ts:464-465` and `telemetry/README.md` list them in this order.
- **Mappings:** `TABLE_FILE_ERROR_CODES` maps the three DBML kinds. `SubjectAreaLoadFailure` gains `'dbml'` → `domainLoadDbml`.
- **Unchanged:** `HEARTBEAT_VERSION` stays 1, and `schemaFormats` is not touched.
- **Fields:** none of the new values holds a name, path or message.
- **Release order:** the PR body says to deploy the Worker (`deploy.yml`) before the extension release. Unknown keys are dropped, not rejected, so an out-of-order deploy only loses counts.

### 7.5 JSON schemas

- `package.json` `jsonValidation` / `yamlValidation` are unchanged.
- `test/unit/fileSchemas.test.ts` gains rows asserting that `.dbml` and `.dbdiagram` paths match **no** schema, and its fixture walk skips `.dbml` and `.dbdiagram`.
- `test/fixtures/dbml-native` is outside `dbt-project/.erd-studio`, so the coverage check is unaffected.

### 7.6 Build and CI

- **`.github/workflows/ci.yml`:**
  - the CLI smoke step adds:
    ```
    node dist/cli.js doctor --project test/fixtures/dbml-native --json > /dev/null
    node dist/cli.js export --project test/fixtures/dbml-native --all > /dev/null
    ```
  - a new step `npm run test:e2e:dbml -- --no-build` runs after the existing `npm run build` step (no second build).
- **VSIX:** no new dist files, so it stays at about 26 files (limit 60).
- **One parser copy** in every bundle (§4.1 rule 5), asserted after the build.
- **Performance budget** (`test/unit/dbmlPerformance.test.ts`, in `npm test`): a generated flat library of 10,000 tables and 30,000 Refs in one `tables/_relationships.dbml`. Budgets, generous enough for CI: reading every relationships file and attaching ≤ 5 s; one relationship edit (plan + `editRelationshipsDbml`) ≤ 3 s, parsing that file **once** (the AST cache in `parser.ts` serves the writer the reader's parse); a canvas load of a 50-table diagram from that library ≤ 3 s. Measured: 20,000 Refs parse in about 0.7 s. The budgets are asserted with a 3× margin printed on failure.
- **Large libraries, documented** (in `docs/dev/dbml.md` and the format reference): every Ref of a folder lives in that folder's file, so a flat SAP-sized library concentrates merge conflicts and makes every other DBML tool load every table of that folder for any diagram (one broken table there breaks those diagrams in other tools, never in ERD Studio, D6). The advice is to use library folders; ERD Studio adds no automatic split rule in 2.0.
- **`dist/webview.js` size:** record before and after in the PR. It must not grow by more than 5 KB, and it must contain no parser (§4.1 rule 4).
- **New fixture `test/fixtures/dbml-native/`** (logical-only, no `dbt_project.yml`):
  - `layers.json` (silver, gold);
  - `tables/dim_date.dbml`;
  - `tables/gold/{fct_order,dim_customer,dim_region,customer_profile,bridge_empty}.dbml`, with comments, `not null` / `default` and an Enum in one of them;
  - `tables/gold/_relationships.dbml`, covering a composite, a role, a duplicate role name, a self-reference, a one-to-one and a many-to-many;
  - `tables/_relationships.dbml`, with the self-reference `Ref "previous day": dim_date.previous_date_key > dim_date.date_key`, so `dim_date.dbml` has a `previous_date_key` column;
  - `gold/sales.dbml` + `sales.dbdiagram`, with two Notes, one linked;
  - `silver/staging.dbml`, with no layout file (auto layout).
- **`scripts/e2e-dbml.mjs`** (npm script `test:e2e:dbml`) runs:
  1. `npm run build`, unless `--no-build`.
  2. Copy `test/fixtures/dbt-project` to a temp dir and delete `.erd-studio/gold/finance.json`. That file is v4: the command would chain the v4 step, which is not under test here. Log it.
  3. Bundle and run `scripts/convert-fixture.ts`. It uses esbuild like `regen-fixtures`, calls `readDbmlConversionInput` + `planDbmlConversion`, asserts no refusals, and writes the plan to disk.
  4. Run `node dist/cli.js doctor --json --no-dbt`, `diff --all --json` and `export --all` on the original copy and on the converted copy, and build each diagram's display in-process with `loadDisplaySubjectArea` (bundled into the script like `convert-fixture.ts`; the CLI gains no display format, it stays read-only with its four formats). Assert that:
     - doctor `erd.storage` is `dbml` and `dbmlProblems` has no errors;
     - the `diff` outputs are equal after normalising file paths (`.yml` → `.dbml`, `logical-models/` → `tables/`, `.json` → `.dbml`) and `schemaVersion`;
     - each diagram's display, passed through `normaliseForStorageEquivalence(…, {convert: true})` (D24), is equal. Byte-equality of mermaid / dbml / dbml-rich exports is asserted only for diagrams the plan's notes do not touch, because composite-key names, respelled ends, rounding and trimmed note text legitimately change export bytes;
     - the layout outputs are equal after the same rounding.

     The one exception is a diagram the plan lists under `movedRelationships`. Its difference must be exactly those relationships appearing, and nothing else (checked by recomputing the expected output with the plan's list).
  5. For every written `.dbml`, compile it as a multi-file project (with its `use` targets, under the virtual root) under `@dbml/parse` 9.1.1 (`dbml-parse-v9`), 10.3.1 (`dbml-parse-v10`) and 11.0.0 (the pin) with zero errors, using `dist`-independent `node_modules` imports.
  6. Exit non-zero on any failure, with a readable diff.

---

## 8. Docs and release

### 8.1 Every doc to update (S9)

**Developer docs:**

- **Root `CLAUDE.md`:**
  - the "What this is" paragraph (stored as DBML, an open format, with YAML/JSON for older projects);
  - "Directory structure", rewritten with the §2.1 tree, the D2–D5 rules, the single detectors (`detectSubjectAreaFormat` for JSON, `detectProjectStorage` for storage, `classifySemanticFile` for paths: "never add a second") and the v6 paragraph kept as the legacy YAML rule;
  - the "Two stages" table's Logical storage cell;
  - the "Edit pipeline" rules: add "DBML writes splice by parser node offsets (`packages/core/src/dbml/`); a no-op save is byte-identical; a file that does not parse is refused, never regenerated; `planDbmlLibraryWrites` only places tables and Refs in files"; keep the yml rules for legacy files;
  - "Never drop a read path": add DBML projects;
  - the harness rule: name the DBML codec;
  - the read-before-touching table: point `docs/dev/dbml.md` at "DBML storage, import and export", and add a row for this spec, `docs/plans/native-dbml-storage.md`;
  - every backticked path must exist (`claudeMdPointers.test.ts`).
- **`packages/CLAUDE.md`:** runtime dependencies are `yaml` + `@dbml/parse` (exact pin); the subpath rule (§4.1); the DBML storage reader and writers list; export rules kept separate from storage.
- **`docs/dev/dbml.md`:**
  - retitle it "DBML storage, import and export";
  - add rows for the codec modules, the relationships file, the diagram file, the splicer, `planDbmlLibraryWrites` and `planDbmlConversion`;
  - rewrite the Parser bullet: `@dbml/parse` **11.0.0**, exact pin in core and the root; bundled into the extension, CLI and MCP server; a core runtime dependency; tests read with 9.1.1 (`dbml-parse-v9`), 10.3.1 (`dbml-parse-v10`) and the pin; ERD Studio writes quoted values only and reads 11.0's unquoted numbers and booleans with a warning; the "quote the value" hint keys on 11.0.0's codes; `updateElementSetting` (10.3.1+) **not** used, because ERD Studio splices itself and 9.1.1 lacks it;
  - document import into a DBML project (D19) and the convert telemetry;
  - delete `:5` and `:25`.
- **`docs/dev/architecture.md`:** the data flow with the DBML branch, the splice write path, `writeNewSubjectArea` → DBML, the watcher globs, the custom editor selector and the reroute (`:13-16`, `:27`, `:83`, `:89-91`, `:103`, `:110`).
- **`docs/dev/compatibility.md`:** the 2.0 format row; the Confluence app needs core 0.4.0 + the `dbml` option; older cores fail transiently (§3.6); the `erd_schema_version` marker; "only a newer schemaVersion may refuse" extended to `erd_schema_version`.
- **`docs/dev/relationships.md`:** in a DBML project relationships are Ref lines in the FK table's folder `_relationships.dbml` (§2.3–2.4); orientation is still `canonicalRelationship` / `planRelationshipWrite`.
- **`docs/dev/releasing.md:19`:** the DBML version key.
- **`docs/dev/feedback.md:14`:** the `redactPaths` shapes gain `.dbml`, `.dbdiagram` and `_relationships.dbml`; `test/unit/feedbackRedaction.test.ts` gains those cases (and `redactPaths` itself is extended if a case fails).
- **`docs/dev/onboarding-and-cli.md`:** the doctor fields `erd.storage`, `erd.dbmlConversion`, `erd.dbmlProblems` (with the severity table), `fix-dbml-file`, `resolve-format-conflicts`, `finish-dbml-conversion`, `import-dbml-file`, the `'newer'` harness state; `--domain` accepts `.dbml`; the round-trip rule becomes "native storage is DBML and edits are byte-preserving; export → dbdiagram → import is still not lossless, and DBML never holds the layout"; "open format", never "open standard".
- **`docs/semantic-domain-json-reference.md`** (**keep the file name**; retitle it "File format reference"):
  - lead with a "DBML project (2.0, the default)" section that is §2 condensed: layout, table, relationships, diagram, layout file, case rules, placeholder, a DBML editing quick reference, validation rules (any parser error makes that file unreadable; quote every custom value; missing `use` targets; duplicates; case; at least one column), "name a Ref only to give it a role", the merge-conflict guidance for `_relationships.dbml` (keep both sides' Ref and `use` lines), the large-library note (§7.6) and a complete example;
  - move the YAML/JSON material under "YAML/JSON projects (schema v4–v6, still read and edited)", keeping every "still read" note.

**User guides:**

- **`docs/glossary.md`:** DBML first in each on-disk cell; mention Convert.
- **`docs/leaving-erd-studio.md`:** your files are already DBML; native split files (with `use`) versus the single-file export for `dbdiagram push`; what Import writes in a DBML project; replace the YAML-comments line.
- **`docs/ai-assistants.md`:** `:3` and `:15` (`orders.dbml`).
- **`docs/dbt.md`:** the TODOs ask for a re-shoot. The alt text keeps describing the current media; flag it in the PR.
- **`docs/plans/dbml-import-export.md`:** add one "Superseded by `docs/plans/native-dbml-storage.md` (2.0 native storage)" note; the history stays.
- **`README.md`:** `:5` tagline, `:25` TODO (`tables/*.dbml`), `:32`, `:34`, and `:44-70` "What's in your repo" (DBML tree, a DBML `Table` example, the JSON Schema claim dropped, and one line on Convert Project to DBML for older projects). Never claim that dbdiagram.io opens the split project directly, a lossless round trip, or that DBML stores layout.

**Packages, UI copy and media:**

- **`packages/core/README.md`:** `:7`, `:12` (dependencies), `:14`, `:26-32` (a DBML `loadDisplaySubjectArea` example with `dbml: dbmlStorageReader`), `:76`.
- **`packages/core/src/exportDiagram.ts:4`:** the header comment that calls YAML/JSON the storage.
- **`src/harness/claude/erd-studio-setup/references/without-dbt.md:85`:** "stay the only copy" (§7.3; the S9 grep below now covers that phrase). **`packages/core/CHANGELOG.md` / `packages/renderer/CHANGELOG.md`:** into the existing 0.4.0 sections (§8.3).
- **`package.json`:**
  - `:4` description: "Logical data modeling in Git: draw ERDs in VS Code, saved as DBML, an open format your AI assistant can read. Import from dbdiagram.io, compare with dbt.";
  - keywords at most 30 (add `dbml editor`);
  - welcome views `:355`, `:360`, `:370`, walkthrough `:408`, `:435`: format-neutral wherever the view can show in a YAML project ("Each table is a file in .erd-studio/ you can commit"), else DBML; keep "an open format, no lock-in";
  - `uiWording.test.ts` rules apply.
- **`media/walkthrough/new-diagram.svg`:** edit the text nodes (`gold/sales.dbml`, `sales.dbdiagram`, `tables/customer.dbml`, `tables/_relationships.dbml`); no new file.
- **`src/types/gettingStarted.ts`:** `:1051`, `:1084`, `:1099` (keep "an open format, no lock-in" for `gettingStartedPanel.test.ts:445`).
- **`webview/components/EmptyCanvas/EmptyCanvas.tsx:46`:** "Each one is a file you can commit." (update `EmptyCanvas.test.tsx`, `logicalOnlyApp.test.tsx:78`). **`src/extension.ts:1533`:** format-neutral.
- **`scripts/social-preview.html:66`:** update. **`video/player/editor.js:57`:** leave, and note the drift in the PR (the video needs a re-render).
- **`.claude/skills/issue-to-pr/references/ripple-map.md:23-27`** and **`cross-repo.md:23`:** add the DBML codec and relationships-file rows.
- **`mcp-server/README.md`:** §7.2.

**Wording rule everywhere:** "open format", never "open standard".

### 8.2 `CHANGELOG.md`

The heading becomes `## Unreleased — 2.0.0`. Reconcile the unreleased lines in place: `:22` (`meta.dbml` also in DBML projects), `:24` (harness v35, not v33/v34) and `:29` (the new Marketplace description). Then add:

- **Added:**
  - Projects are stored as DBML, an open format: one `.dbml` per table in `tables/`, relationships as `Ref` lines in `tables/…/_relationships.dbml`, and diagrams as `.dbml` with `use` lines plus a `.dbdiagram` file for positions. DBML parsers 9.1 and 11+ read the project (10.x too, unless a folder in its path has a space), and hand edits and comments are kept.
  - **ERD Studio: Convert Project to DBML**: a dry run, refusals rather than guesses, one undoable edit, a preview in `erd-studio doctor`, and an offer when you open a diagram.
  - `doctor` reports `storage`, DBML problems and the Convert preview.
- **Changed:**
  - New projects write DBML. Existing YAML/JSON projects keep loading and stay fully editable; nothing converts unless you ask.
  - The CLI and MCP server read DBML.
  - The bundled DBML parser is `@dbml/parse` 11.0.0 (was 10.3.1). Import DBML now also reads files with unquoted number and boolean values (`scd_type: 2`, `natural_key: true`); ERD Studio's own files still quote every value, so DBML 9 and 10 tools read them.
  - Deleting a table in a DBML project also removes its relationships and its place in diagrams.
  - The AI helper files are harness v35.
- **Upgrade path** (`releasing.md:23`): "Nothing changes in your project until you run Convert Project to DBML. Before converting, commit your work: Undo works while VS Code stays open, and git is the safety net."
- The release is a **major**. The changelog says so, and the breaking items for tools that read `.erd-studio` directly are new projects being DBML and the `erd.storage` field.

### 8.3 Package versions

- core and renderer stay at `0.4.0`, and the renderer's exact core pin stays `0.4.0`. The root `@dbml/parse` moves to `11.0.0` with core's (S2); no other root dependency changes.
- **The 0.4.0 changelog for core:**
  - **Added:** `@erd-studio/core/dbml`, the DBML storage reader and writers; `detectProjectStorage`; `classifySemanticFile` and the path helpers; `editDiagramLayout`; `CURRENT_JSON_SCHEMA_VERSION`; `DBML_SCHEMA_VERSION`; the `dbml` and `maxRelationshipsChars` options of `loadDisplaySubjectArea`; `nextCompositeKey` (moved from the extension); `normaliseForStorageEquivalence`; `ERD_STUDIO_DBML_HEADER_PREFIX`.
  - **Changed (breaking):**
    - `@dbml/parse` 11.0.0 (exact) is a runtime dependency;
    - `CURRENT_SCHEMA_VERSION` is 7;
    - `TableLoadErrorKind` gains three members, so an exhaustive `Record` or `switch` needs cases;
    - `SubjectAreaFileErrorReason` gains `'invalid-dbml'`;
    - `TableLoadError.code` is added;
    - the "not found in the table library" warning text;
    - cores ≤ 0.3.0 cannot read DBML projects.
- **The 0.4.0 changelog for the renderer:** the format-neutral load-error label.
- **Confluence:** add the bump note from §1.

---

## 9. Test plan

All of these run in `npm test` unless marked otherwise. Run every multi-parser check with `packages/core/test/exportParsers.ts` (or a sibling helper) over `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0: the `dbml-parse-v9` and `dbml-parse-v10` aliases and the pinned `@dbml/parse`. A test that asserts an error **code** (the quote hint) runs with the pin only, because 9.1.1 numbers its codes differently.

### 9.1 Core: parser-free (S1)

- **`packages/core/test/unit/storage.test.ts`:**
  - `classifySemanticFile` over every row of §3.5, both `tablesDirIsLayer` states, `_`-prefixed stems (`_x.dbml` in a layer is a diagram; `_relationships.dbml` / `_Relationships.dbml` in `tables/` are relationships; `tables/_relationships.yml` is a table), folders like `Finance` and `SAP FI`, the export-header `firstLine`, and depth 1 and 2;
  - `tableFileCandidates` order, with a snapshot of the list;
  - the posix helpers, including `..` and confinement;
  - the reserved name, and `toSubjectAreaSlug` never yielding `_relationships`.
- **`packages/core/test/unit/projectStorage.test.ts`:** the full §3.2 rule table, including an empty `logical-models/` (YAML) and `.dbml` diagrams beside JSON ones (still `yaml`).
- **`dbdiagramLayout.test.ts`:**
  - `editDiagramLayout` returns null when unchanged;
  - unknown keys are kept;
  - it creates only when non-empty and refuses non-JSON;
  - `read(edit(x))` gives back positions and sticky layouts;
  - `placeUnlaidNotes` is deterministic and never overlaps laid-out positions.
- **`storageEquivalence.test.ts`:** each §2.8 row in isolation (and that nothing else is normalised: a changed column type, role or member is still a difference).
- **`relationships.test.ts`:** `nextCompositeKey` moved, and the host re-export is the same function.
- **`domainFormat.test.ts` / `domain.test.ts`:**
  - a JSON file with `schemaVersion: 7` is still refused with the identical message;
  - `classifyTableLoadError` / `describeTableLoadError` for the DBML kinds, including the `3025` / `3075` quote hint and no hint for `3073`;
  - the neutral "not found in the table library" text (also in `loadDisplayDomain.test.ts`).
- **`exportDbmlRich` goldens** are byte-identical after the `dbmlText.ts` move.

### 9.2 Core: readers and loader (S2)

- **`dbmlReadTable.test.ts`:**
  - every §2.2 mapping row;
  - the `erd_` prefix;
  - 9/10/11 property shapes (the pin reads 11.0's `{value, type}`; feed the v9 and v10 aliases through the injectable parser parameter);
  - the placeholder;
  - the inline `ref:` / `use` / `Ref` cases: the table loads, `writable: false`, the problem holds the exact Ref line to add;
  - a stem that differs from the declared name only in case loads, with the declared spelling; one that differs otherwise is `nameMismatch`;
  - schema-qualified names and an `as` alias (`declaredReference`, `alias`);
  - a leading BOM;
  - syntax, invalid and binding classification, and the `3025`/`3075` "quote the value" hint under the pin (unquoted `role: fact`, `grain: one row`, `k: null`);
  - typed values under the pin: `natural_key: true`, `TRUE` and `false`, `scd_type: 2`, `meta_owner: 007` and `w: 1.50` read as `true`, `true`, unset, 2, `'007'` and `'1.50'`, each with an `unquotedValue` warning; the same files fail `[3025]` under the v9 and v10 aliases (no hint asserted there);
  - conflict markers;
  - a path with a space is irrelevant (fixed virtual path), under the v10 alias as well as the pin;
  - `meta_json` precedence and invalid JSON.
- **`dbmlReadRelationships.test.ts`** (with `attachRelationships`):
  - every operator row, including `<` and the `?` marks, and the three one-to-one direction cases (mark, keys, position), the shared-primary-key pattern included;
  - composites;
  - roles, including duplicate names;
  - a self-reference;
  - a dangling target;
  - a missing `use` target or a deleted table file, where every Ref is still read (the 4000/4001 tolerance);
  - a syntax error, which reads as unreadable (with `mergeConflict` for markers);
  - `compositeKey` derivation calls `nextCompositeKey` itself;
  - a misplaced Ref attaches with a warning; an orphaned one does not;
  - the same link in two files, and twice in one, is attached once by the ranking, with a warning naming both;
  - schema-qualified ends (`gold.x.col`) and alias ends map to their table.
- **`dbmlReadDiagram.test.ts`:**
  - Project keys, including unknown ones; the v5 object's `schemaVersion` is 5 and `reading.schemaVersion` is 7, and `detectSubjectAreaFormat(obj)` is `v5`;
  - members and their order, including duplicates;
  - member stems from semantic-dir-relative, wrong-folder and wrong-case paths, with `usePathMismatch` warnings; an unsafe stem is ignored with a warning; a `_x` table is a member;
  - Notes, with colour mapping and an empty body;
  - layout merge, including a Note with no layout (`placeUnlaidNotes`);
  - version refusal;
  - `invalid-dbml` transient vs merge conflict;
  - a declared `Table`, `Ref` and `TableGroup`, a repeated Note name and a second Project each read with a warning (`writable: false` for the last two), confirmed against all three parsers;
  - the import-banner condition (Tables declared, no table `use` lines);
  - a leading BOM.
- **`loadDisplayDomain.dbml.test.ts`:**
  - the `dbml` option is required for `.dbml`;
  - a table file and a relationships file passed as `domainPath` throw the not-a-diagram error;
  - probe order and `useFolders`;
  - `maxModels`, `maxYamlChars`, `maxRelationshipsChars` and `maxDomainChars` on DBML files;
  - a misplaced Ref in a member folder's file is drawn;
  - a JSON diagram in a mixed project draws DBML tables plus their relationships;
  - a DBML member that resolves to a `.yml` is drawn with a warning;
  - JSON without the option is unchanged (the existing tests pass untouched).
- **Goldens:**
  - DBML twins `packages/core/test/fixtures/dbml/<case>/.erd-studio/…` for `showcase`, `library-relationships`, `composite-and-self`, `missing-positions` and `missing-model`. They are hand-written in S2 and checked in S7 to be byte-equal to Convert's output (§9.6), except `missing-model`, which is not a Convert result (see §9.6).
  - `displayDomainGolden.test.ts` and `loadDisplayDomain.golden.test.ts` assert, for each twin, that `normaliseForStorageEquivalence(twin display)` **equals** `normaliseForStorageEquivalence(YAML case's golden)` (D24), which covers the `schemaVersion` override (the naming-v6 twin pattern, `displayDomainGolden.test.ts:441-461`). Each case lists in the test, with a one-line reason each, which §2.8 rows it exercises: `composite-and-self` (composite-key names, the lone `fk_lonely` key at `composite-and-self.unified.json:55`, respelled `Mentor_ID` / `Employee` / `EMPLOYEE_ID` at `:110-112`), `showcase` (note whitespace, position rounding, if its data has them), and none for the rest. A row a case does not list must not change that case. **Enforced (S2 review):** the test compares each twin with only its listed rows applied (`normaliseStorageRows`, internal to `storageEquivalence.ts`) and checks that dropping any listed row makes the two differ. On the Display shape core compares, the lists are: `showcase` and `missing-positions` relationship order, empty sticky-note list, schemaVersion; `library-relationships` one-to-many, schemaVersion; `composite-and-self` and `missing-model` schemaVersion only. The composite-and-self rows above touch only the Unified shape, which the host compares in S4.
  - The only allowed exception beyond those rows is `library-relationships`: its YAML fixture has a disagreeing domain-file copy that DBML cannot hold. It gets its own flat golden `dbml-library-relationships.host.json` / `.unified.json`, with the one-line reason in the test.
  - New error goldens (flat, in `golden/`, all added to `EXPECTED_FILES` and to `SUBJECT_AREA_CASES` / `ERROR_CASES` in **both** `loadDisplayDomain.golden.test.ts` and `exportDiagram.golden.test.ts`): `errors.dbml-syntax.host.json`, `errors.dbml-future.host.json`, `errors.dbml-not-a-diagram.host.json` (a table file passed as `domainPath`), `errors.dbml-conflict.host.json`.
  - **No sub-directories under `golden/`**, because of `:496` and `rmSync` at `:306`.
- **Boundaries:**
  - `packagesBoundary.test.ts` enforces the §4.1 rules 1–3;
  - `packagesNodeNext.test.ts` compiles a consumer importing `@erd-studio/core/dbml` with `skipLibCheck: false` (`@dbml` added to its symlink list, `:110`), and asserts that no emitted `dist/dbml/*.d.ts` names `@dbml/parse` (§4.1 rule 6);
  - a test loads the **built** `dist/index.js` and `dist/dbml/index.js` and asserts that a `SubjectAreaFileError` thrown through `dbmlStorageReader.parseSubjectArea` passes `instanceof` against the main entry's class (the `splitting` build, D13);
  - `npm run build:packages` emits `dist/dbml/`.

### 9.3 Core: writers (S3)

- **`dbmlWriteTable.test.ts`:**
  - one test per §4.5 table operation;
  - inline vs multi-line settings;
  - the `erd_` spelling kept;
  - PK size transitions 0 ↔ 1 ↔ 2;
  - placeholder in and out;
  - reorder with comments above columns;
  - removing a column with comment lines above it keeps those comments, and removing or editing the **first** Table never touches the file's header comment (the `fullStart` trap);
  - a new attribute list on `Table x as X {` goes after the alias;
  - a rename (qualifier and alias kept);
  - the qualified-schema refusal;
  - an unparseable file, and a `writable: false` one (inline ref), are refused with the reader's message;
  - a BOM kept;
  - Law 1 on `indexes { id [pk] }`, `primary key` flags and a `meta_<key>` overriding `meta_json` (untouched);
  - CRLF preserved;
  - quoting of keywords, uppercase, digit-leading and odd names (all names `validateTableNameSafety` allows);
  - 2000-character meta values with quotes, backslashes and newlines;
  - typed values (§2.2): a file holding `natural_key: true` and `scd_type: 2` keeps both byte for byte through a no-op and through an edit to another column; changing `scd_type` writes `scd_type: '1'`; nothing is requoted unasked.
- **`dbmlWriteRelationships.test.ts`:**
  - insert at the sorted position into sorted and unsorted files;
  - unchanged Refs keep their bytes, including `?`, `[delete: cascade]` and trailing comments;
  - regeneration keeps the settings;
  - owner rename and move; an `incoming` Ref keeps `[delete: cascade]`, `?` and its trailing comment;
  - `use` lines added, removed and kept; hand-added extra `use` lines and missing ones are left alone unless their table is in this edit (Law 1);
  - `use` block insertion after a header comment followed by a blank line, and at offset 0 when the comment runs into the first Ref;
  - selective `use { table <reference> }` lines, with a schema-qualified reference;
  - real column spellings on inserted Refs;
  - the file is never deleted;
  - create from null;
  - one-to-one writes the FK second with `?-`; many-to-one `>?`; many-to-many `<>?`;
  - composite;
  - the refusals (same columns, duplicate endpoint sets, YAML other end).
- **`dbmlWriteDiagram.test.ts`:**
  - every §2.5 mapping;
  - each refusal, `writable: false` and a `schemaVersion` change included;
  - a member path rewrite on rename and on a stale path; **no** rewrite when the line's target exists but the name resolves to another copy;
  - an existing YAML-resolving member keeps its bytes;
  - relationships `use` maintenance only on a membership change or `refreshRelationshipsUses`;
  - Note add, edit and remove;
  - the Project block inserted when missing (both `headerEnd` shapes);
  - a diagram rename through `after.domain`.
- **`dbmlCodecLaws.test.ts`:**
  - Laws 1–5 over every table, relationships file and diagram in `packages/core/test/fixtures/dbml/**` and `test/fixtures/dbml-native/**`;
  - a **seeded generator** (no new dependency: a small mulberry32 PRNG, about 300 cases per run, the seed printed on failure) builds random `SemanticTable`s and relationship lists and random edits over them, and checks Laws 1–5.
- **`dbmlMultiParser.test.ts`:** every text any writer test produces from an input that parses in all three (or from `null`), collected through a helper, is compiled multi-file with its `use` targets under 9.1.1, 10.3.1 and 11.0.0 with **zero** errors and warnings.

- **Metadata blocks (D25):** for a table file with `Metadata Table` / `Metadata Column` blocks (before and after the Table, triple-quoted values): editing a block-set property changes the block entry and the re-read value equals the edit in 9.1.1, 10.3.1 and 11.0.0; clearing removes the entry; an inline duplicate shadowed by a block is removed on clear; column and table renames retarget the blocks; column delete removes its blocks; a no-op save is byte-identical; a block in another file refuses with `DbmlEditRefused`; `note`/`headercolor` via block.

### 9.4 Host: read (S4)

- **`logicalModelService.dbml.test.ts`:**
  - listing and shadowing (`.dbml` over `.yml` in one dir; `logical-models/` over `tables/`), folders `Finance` and `SAP FI`, a YAML `_relationships.yml` still listed;
  - `findTableFile` parity with core's `tableFileCandidates` (a table-driven test over the same fixtures);
  - **case**: a wrong-case lookup returns the listed stem and path, never the probe's spelling (simulated case-insensitive listing), and a stem/name case drift loads;
  - `listTables()` returns DBML tables **with** their relationships, misplaced Refs attached;
  - cache invalidation on a table vs a relationships-file change;
  - DBML `TableFileError`s;
  - `hasTablesLibrary` / `tablesDirIsLayer` with `.dbml`, every row of the §3.3 table.
- **`domainService.dbml.test.ts`:** `listSubjectAreas` storage and conflict (an export-headed `.dbml` in a layer is not listed), `getSubjectArea` equivalence with core `loadDisplaySubjectArea` on `dbml-native`, and `subjectAreaTableNames`.
- **Existing suites with DBML cases added:** `fileWatcherService.test.ts` (each classification, layout → diagram, a relationships event, **one** table event per table-file change, no delete toast for tables, the foreign-format toast), `layerService.test.ts`, `semanticFileDecorationProvider.test.ts`, `modelLibraryTreeProvider.test.ts` (`openWith 'default'`), `projectStorage.host.test.ts`, `physicalTooling` tests.
- **`semanticEditorProvider.dbmlRead.test.ts`:** a DBML diagram renders; the reroute for `file:` table and relationships files and **no** reroute for a `git:` URI; `recordCanvasOpen` makes no `JSON.parse`; the cross-panel refresh on a table change; every `detectSubjectAreaFormat` call site sees `v5`; the import banner message.
- **CLI read (S4):** `cli.doctor.test.ts` lists DBML diagrams (no `parseSubjectAreaJson` on `.dbml`), `cli.diff.test.ts` resolves a `.dbml` `--domain` (`resolveSubjectAreaPath`, the `basename` at `diff.ts:495`), `cli.export.test.ts` exports a `.dbml` diagram.

### 9.5 Host: write (S5)

- **`dbmlLibraryWrites.test.ts`:** each op kind, one write per file, `pathChanged`, `createdRelationshipsFiles`, and refusals passing through; **the rename ops shape** `save: [{model, fromName: old}]` + `delete: [old]` (folded, the owner's Refs re-spelled, not dropped); a misplaced Ref moved home verbatim in the owner's write; a moved owner's Refs carried verbatim; the cross-file duplicate refusal (two folders' files, and twice in one); the D20 refusal for a YAML other end.
- **`applyFileWrites.test.ts`:** the order (creates with relationships files first, replaces, deletes); a `false` from `applyEdit` after some creates and a delete has landed (the mock applies a prefix) is reconciled to the exact prior state; a failing reconcile shows the restore-from-source-control modal.
- **`fsFileWrites.test.ts`:** `writeFilesWithRollback` restores every snapshot when the n-th write fails, for every n; BOM kept.
- **`semanticEditorProvider.dbml.test.ts`** runs every row of the §5.3 handler table on a copy of `dbml-native` and asserts:
  - exactly one `applyEdit`;
  - the expected set of written paths;
  - each written file parses (multi-parser);
  - re-reading gives the intended state;
  - a no-op edit leaves every byte unchanged;
  - dirty-file refusal by name;
  - `editedTablePaths` and ownWrites cover every written path;
  - D20 refusals in a mixed project (YAML member, and a DBML-owner relationship to a YAML table);
  - the reserved-name refusal on add and rename.
- **`relationshipStateSpace.dbml.test.ts`:** a DBML variant of `relationshipStateSpace.harness.ts` that materialises `tables/**.dbml` + `_relationships.dbml` and reads back through `TableLibraryService`. The universes (`relationshipStateSpace.universes.ts:5-16`) store links either way round, as partials, as one-to-many records and in diagram files D1–D3, which DBML cannot hold. So each universe state is **projected through the DBML codec** (diagram copies dropped, orientation canonicalised, partials and one-to-many records as the reader would read them); states the projection changes beyond §2.8 are skipped and counted (the count is printed, and a floor is asserted so the suite cannot silently skip everything). The invariants that still apply are named in the test: one link per `linkKey`, ownership by the FK side, every write lands in the owner's folder file, every planner output is **representable** (writing it and reading it back gives the planner's state modulo §2.8), and Laws 1–5 on every file written.
- The existing `semanticEditorProvider*.test.ts`, `libraryRelationships`, `planRelationshipWrites` and `relationshipStateSpace.*` tests pass **unchanged**, proving the YAML path is untouched.

### 9.6 Lifecycle, Convert and CLI (S6–S8)

- **Lifecycle (S6):**
  - DBML-project cases in `drawFromDbt.writes.test.ts`, `importDbml.test.ts`, `openExampleDiagram.test.ts`, `extension.test.ts` (createDomain, renameDomain, deleteDomain, setup), `modelLibraryOrganizer.test.ts`, the duplicate resolver test, a delete-table cascade test, and `syncPlanBuilder` paths;
  - rollback of every write kind in `newSubjectAreaWriter`.
- **`dbmlConversion.test.ts`** (S7): one test per refusal; notes for comments, unknown keys and anchors (the comment block content asserted); moved relationships listed with their diagrams; v4 surfaced; and each normalisation of §6.1 step 3 with its note: column respelling (the `composite-and-self` `employee.yml`), a dangling target table and a dangling target column (commented Ref), a link stored in both ends' files (`>`, reversed `-` and `<>`), a library `one-to-many`, disagreeing composite roles, duplicate sticky-note ids. Also:
  - **mixed**: a fixture with an existing `tables/gold/_relationships.dbml`, a DBML diagram and YAML tables added beside them; the plan `replaces` the relationships file and the DBML diagram (new `use` lines) and compiles clean;
  - **resume**: a half-applied run (some targets written with the planned bytes, the sources still there) plans the rest, with `resumed` listed, and `doctor` raises `finish-dbml-conversion`; a target with different bytes is refused;
  - a library folder that is not a layer gives no false self-check refusal;
  - a forced self-check failure produces the named refusal.
- **`dbmlConversion.golden.test.ts`:** the planner over each core YAML fixture equals `packages/core/test/fixtures/dbml/<case>` **byte for byte**. `library-relationships` is expected to refuse because of its disagreeing copy; the test asserts the refusal, and the twin is compared against a variant fixture without the domain copy. `missing-model` is excluded from the byte check: its twin is a reader tolerance case (a hand-made `broken.dbml` syntax error, which Convert cannot write from an unreadable `broken.yml`; no `nameless` table; the diagram's two relationships from `dim_missing` and `broken` absent, where Convert would write commented-out Refs). S7 asserts Convert's own result for that fixture instead (a refusal or its documented notes), not byte equality with the twin.
- **`dbmlConversion.dbtProject.test.ts`:** a temp copy of `test/fixtures/dbt-project` minus `gold/finance.json` is planned and written. For every diagram the display (through `SubjectAreaService`), passed through the comparator, is equal before and after, apart from the documented moved relationships. Every file passes the multi-parser compile.
- **`convertProjectToDbml.test.ts`:** the command flow (v4 chain, refusal modal, dirty refusal, re-plan mismatch, the teammate and git-history lines in the modal, one `applyFileWrites`, the reconcile after a partial `false`, folder cleanup, tab reopen, telemetry for success, failure, refusal, cancel and Not Now), modelled on `migrateNaming*.test.ts`. `migrateNaming*.test.ts` gains the reconcile case for the shared helper.
- **CLI (S8):**
  - `cli.doctor.test.ts`: `storage`, `dbmlConversion`, `dbmlProblems` (each check, with its severity from the §7.1 table, and the exact line in the message where the table says so), `mergeConflict` routing to `resolve-merge-conflicts`, the new next steps, warnings raising no next step, `update-harness` for an outdated `.agents` / Copilot / Gemini / `AGENTS.md` target alone, a newer marker reported as `'newer'` and never as `update-harness`, `pathWithSpace`, `tablesLayerConflict`, `missingLayersConfig`, and storage `dbml` with no `.erd-studio`;
  - `cli.inventory.test.ts`: `format`, members from `use` lines with a missing table file;
  - `cli.diff.test.ts`: DBML fix paths, the `fix-dbml-file` FixKind, `dbml-invalid`, `not-a-diagram`, and YAML/DBML twin parity on the converted dbt-project copy;
  - `cli.export.test.ts`: the usage text, and a DBML diagram export equals its YAML twin;
  - `cli.logicalOnly.test.ts`: `dbml-native`;
  - `cli.noVscode.test.ts`: inverted (§7.1).
- **Harness:** `harnessService.test.ts` and `harnessAssets.test.ts` updated: every generated skill file ≤ 500 lines and ≤ 48 KB, the `DBML.md` / `LEGACY.md` companions marked and covered by `fileState`, `detectStale` and Update All, the single-file targets carrying the full text, the `'newer'` state never replaced, the setup `SKILL.md` still < 500 with the new ids routed, the route-2 Glob skipping the semantic dir. `fileSchemas.test.ts` rows. `telemetryPayload.test.ts` parity and order, and `node --test telemetry/test/worker.test.mjs`.
- **Export:** `exportDiagram.test.ts` / `exportAllDiagrams.test.ts`: a Save As target inside the semantic dir is refused, and the default folder is the workspace root.
- **Import:** `importDbml.test.ts`: a file with `use` lines is refused with the multi-file message.
- **MCP:** `cd mcp-server && npm run build && node test-smoke.mjs`.
- **End to end:** `npm run test:e2e:dbml` (§7.6, run in CI).

### 9.7 Manual dev-host checks (recorded in the PR)

1. Explorer double-click on `tables/x.dbml` and `tables/_relationships.dbml` opens text (§5.9), and the Source Control diff and the merge editor of `tables/_relationships.dbml` (make a conflict on a scratch branch) both work.
2. Cmd+Z and toolbar Undo after a drag (layout only), a column edit, a relationship add, and a rename.
3. Convert on a copy of `dbt-project` (with its v4 file): the preview (teammate and git-history lines), then apply, then the reopened tabs, then Undo. Then Convert on a mixed copy.
4. Old-project flow: open a YAML project. The offer appears once, Don't-ask-again holds, and nothing is written on activation.
5. A new empty folder: New Diagram writes `.dbml` and `layers.json`, and the first table creates `tables/<layer>/x.dbml`.
6. A `.dbdiagram` file opens as JSON with highlighting.
7. Drop a dbdiagram single-file `.dbml` into a layer folder: the import banner shows and Import works.

---

## 10. Stages

Every stage ends with `npm run compile` and `npm test` green. The YAML/JSON behaviour stays byte-identical throughout: no existing golden changes except `golden/logs.json` in S1, and no existing test changes except the ones a stage lists by name. Each stage commits on `feat/native-dbml-storage` with the attribution lines. Stages run in order. S4–S6 may leave DBML **editing** unavailable between them, but never broken YAML editing. The empty-project default flips to DBML in **one** stage, S6 (§3.2).

### S1: Core foundations (parser-free) and exhaustive fallouts

- **Goal:** the parser-free core API and the version, storage, classification, comparator and error-kind plumbing, wired through every exhaustive site.
- **Files:**
  - **Core:**
    - `packages/core/src/types/semantic.ts` (§3.1, §3.2 with `hasV5Folder`, `TableLoadErrorKind`, `TableLoadError.code`);
    - `packages/core/src/storage.ts` (new: classifier with `firstLine`, candidates, `isLibraryFolderName`, `diagramPathOfLayout`, posix helpers, reserved name);
    - `packages/core/src/dbmlText.ts` (new, moved helpers) and `exportDbmlRich.ts` (imports them);
    - `packages/core/src/dbmlRichProperties.ts` (new constants, `ERD_STUDIO_DBML_HEADER_PREFIX` moved in) and `src/services/dbmlImportParse.ts` (re-exports it);
    - `packages/core/src/dbdiagramLayout.ts` (`editDiagramLayout`, `stickyLayoutsOf`, `placeUnlaidNotes`);
    - `packages/core/src/relationships.ts` (`nextCompositeKey` moved in) and `src/services/libraryRelationships.ts` (re-export);
    - `packages/core/src/storageEquivalence.ts` (new, D24);
    - `packages/core/src/domain.ts` (JSON ceiling constant, `'invalid-dbml'` reason, DBML kinds in classify/describe with the `3025`/`3075` hint, in the 11.0.0 numbering although the root still resolves 10.3.1 until S2: S1 is parser-free and the two share these codes, §4.7, the neutral warning texts at `:659` and `:826` only);
    - `packages/core/src/index.ts`, `src/types/semantic.ts` (re-exports).
  - **Fallouts:**
    - `src/services/telemetryPayload.ts`, `telemetry/src/index.js`, `telemetry.json`, `telemetry/README.md`, `telemetry/test/worker.test.mjs`, `test/unit/telemetryPayload.test.ts` (every code and feature of §7.4, in order);
    - `src/cli/diff.ts` (`TABLE_FILE_HINTS`), `src/commands/openModelFile.ts`;
    - `packages/renderer/src/components/Graph/ModelNode.tsx`;
    - `src/services/commandErrors.ts`, `SubjectAreaLoadFailure` (`'dbml'`).
  - **Goldens and existing tests:** `packages/core/test/fixtures/golden/logs.json` regenerated (`UPDATE_GOLDEN=1`, review the diff: only the warning text); the same text in `packages/core/test/unit/domain.test.ts` and `packages/core/test/unit/loadDisplayDomain.test.ts`.
  - **Tests:** §9.1.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npm run build:packages`;
  - `git diff --stat packages/core/test/fixtures/golden` shows only `logs.json`;
  - `node --test telemetry/test/worker.test.mjs` (or the CI telemetry command).
- **Depends on:** nothing.

### S2: Core DBML readers, the loader and the subpath

- **Goal:** core reads DBML projects tolerantly (BOM, inline refs, misplaced and duplicate Refs, declared constructs in diagrams, case drift, qualifiers and aliases), `loadDisplaySubjectArea` draws DBML diagrams, and the parser is isolated behind `@erd-studio/core/dbml` with one module graph.
- **Files:**
  - **Core:**
    - `packages/core/src/dbml/{index,parser,parserModule,readTable,readRelationships,readDiagram,compileProject,errors}.ts` (§4.3; `parser.ts` internal; every reader takes the optional `parser`);
    - `packages/core/src/types/dbmlStorage.ts`;
    - `packages/core/src/loadDisplayDomain.ts` (§4.4: not-a-diagram rule, every probe-set relationships file, `maxRelationshipsChars`, the `schemaVersion` override);
    - `packages/core/package.json` (the exact `"@dbml/parse": "11.0.0"` dependency, exports, the `@dbml/parse` devDependency entry removed, `dbml-parse-v10` added, `dbml-parse-v11` removed; §4.1 "Parser pin"), `packages/core/build.mjs` (one `splitting` call), `packages/core/tsconfig.build.json`;
    - root `package.json` (`@dbml/parse` `10.3.1` → `11.0.0`: **the pin moves in this stage**, together with core's, so no stage ever bundles two copies) and root `package-lock.json` (regenerated by `npm install`).
  - **Existing tests and docs switched to the 11.0.0 pin** (§4.1 "Parser pin"): `packages/core/test/exportParsers.ts`, `test/unit/dbmlImportParse.test.ts` (parser list, the rewritten "unquoted number" case), `test/unit/dbmlImport.test.ts`, `test/unit/dbmlRoundTrip.test.ts`; `docs/dev/dbml.md:25-26` (the three pin facts only).
  - **Plumbing:** root `tsconfig.json`, `mcp-server/tsconfig.json`, `vitest.config.ts`.
  - **Fixtures:** `packages/core/test/fixtures/dbml/{showcase,library-relationships,composite-and-self,missing-positions,missing-model}/` and the DBML error fixtures beside the existing `errors` fixtures.
  - **Goldens:** the new flat goldens (§9.2).
  - **Tests:** `test/unit/displayDomainGolden.test.ts`, `packages/core/test/unit/loadDisplayDomain.golden.test.ts`, `exportDiagram.golden.test.ts` (new cases only), `test/unit/packagesBoundary.test.ts`, `test/unit/packagesNodeNext.test.ts` (`@dbml` symlink, `skipLibCheck: false` consumer, no-leak assertion), the built-dist `instanceof` test, and the new reader tests.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npm ci` succeeds in a scratch clone of the branch (the committed lock is in step);
  - `node -p "require('@dbml/parse/package.json').version"` prints `11.0.0` and `node -p "require('dbml-parse-v10/package.json').version"` prints `10.3.1`; `grep -rn "dbml-parse-v11" package.json packages src test scripts mcp-server/src` finds nothing;
  - no existing import or export golden changes with the pin (`git diff --diff-filter=M --stat <S1 commit> -- packages/core/test/fixtures test/fixtures` lists nothing);
  - `npm run build:packages && ls packages/core/dist/dbml/index.js packages/core/dist/dbml/index.d.ts && ! grep -rl "@dbml/parse" packages/core/dist/dbml/*.d.ts`;
  - `npm run build && ! grep -q UNEXPECTED_ELEMENT_DECLARATION dist/webview.js`;
  - `npm pack --dry-run -w @erd-studio/core` lists `dist/dbml/`.
- **Depends on:** S1.

- **D25 (added 2026-10-28):** map the Metadata-target-missing [4000] to the precise load error of §4.7 and cover it in the reader tests.

### S3: Core DBML writers (the splicer)

- **Goal:** pure writers for table, relationships and diagram files that obey Laws 1–5 on hand-written files, cut by `start`/`fullEnd`, keep BOMs, write selective `use` lines and FK-marked operators, and touch derived blocks only when their inputs change.
- **Files:**
  - `packages/core/src/dbml/{splice,writeTable,writeRelationships,writeDiagram}.ts`, exported from `packages/core/src/dbml/index.ts`;
  - `packages/core/test/unit/{dbmlWriteTable,dbmlWriteRelationships,dbmlWriteDiagram,dbmlCodecLaws,dbmlMultiParser}.test.ts`.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npx vitest run packages/core/test/unit/dbmlCodecLaws.test.ts packages/core/test/unit/dbmlMultiParser.test.ts`, three times with different seeds (`DBML_LAW_SEED=1|2|3`).
- **Depends on:** S2.

- **D25 (added 2026-10-28):** the writer handles `Metadata` blocks per §4.5.x, with the §9.3 Metadata tests.

### S4: Host read integration (extension and CLI reads)

- **Goal:** the extension and the CLI **read** DBML projects (the MCP tools follow in S8). Diagrams open, the trees list them, watchers react once per change, the reroute works for `file:` documents only, and `doctor` / `diff` / `export` accept `.dbml` diagrams. DBML diagram edits are temporarily refused with "Editing DBML diagrams is not available yet" (removed in S5). Create paths still write YAML/JSON.
- **Files:**
  - **New:** `src/services/projectStorage.ts`, `src/providers/subjectAreaCodec.ts` (parse and `tableNames` for both, render for JSON; `dbmlSchemaVersion`, `writable`).
  - **Library and services:**
    - `src/services/logicalModelService.ts` (§5.1 read parts: the one private reader `readTableEntry`, listing-based `findTableFile` with listed stems, folder rule, relationships cache and memoised attachment, `tablesDirIsLayer` per §3.3, `hasTablesLibrary`, the public `pathForNewTable` wrapper still returning today's paths);
    - `src/services/domainService.ts` (`listSubjectAreas` with `firstLine`, `getSubjectArea`, `isSubjectAreaFilePath`, `countSubjectAreaFileRelationships`, `subjectAreaTableNames`);
    - `src/services/layerService.ts`;
    - `src/services/projectNaming.ts` (ignore `.dbml`), `src/services/namingMigrationFiles.ts` (filter);
    - `src/services/physicalTooling.ts`.
  - **Watchers and providers:**
    - `src/watchers/FileWatcherService.ts` (semantic watcher ignores `table`; the foreign-format toast);
    - `src/providers/{SemanticFileDecorationProvider,DomainTreeProvider,ModelLibraryTreeProvider,SemanticEditorProvider}.ts` (parse via the codec, `file:`-only reroute, `refreshSubjectAreasReferencingTable`, `recordCanvasOpen`, the import banner message);
    - `src/types/messages.ts`, `src/providers/payloadValidation.ts` (`dbmlEmbeddedTables`, `importEmbeddedTables`) and the webview banner.
    - **§4.7 webview fallouts deferred from S1:** `webview/App.tsx` and `webview/components/Toolbar/Toolbar.tsx` ("isn't valid JSON" → "isn't valid <JSON|DBML>", "Open as JSON file" → "Open file", the file type from the error's file extension), and `SemanticEditorProvider.subjectAreaFileProblemPayload` (today `if (err.reason !== 'invalid-json') return undefined;`): an `'invalid-dbml'` diagram gets `fileProblem: 'syntax'` with its file type, so a broken DBML diagram shows the syntax screen.
  - **CLI read (moved here from S8 so this stage's acceptance can run):** `src/cli/doctor.ts` (the diagram loop: `parseSubjectAreaJson` / `detectSubjectAreaFormat` only for `.json`, `.dbml` through `parseSubjectAreaDbml`), `src/cli/diff.ts` (`resolveSubjectAreaPath` and the `basename` at `:495` through `subjectAreaStorageOf`), `src/cli/export.ts` / `src/services/diagramExport.ts` (pass `dbml: dbmlStorageReader`), `src/cli/context.ts` (`projectStorageOf`).
  - **Commands and manifest:**
    - `src/commands/openModelFile.ts`;
    - `src/extension.ts` (context keys, the `erdStudio.storage` key, the `tablesLayerConflict` toast);
    - `package.json` (selector, the `.dbdiagram` language contribution).
  - **Fixture:** `test/fixtures/dbml-native/`.
  - **Tests:** §9.4.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npm run build && node dist/cli.js doctor --project test/fixtures/dbml-native --json` exits 0 and lists every diagram;
  - `node dist/cli.js export --project test/fixtures/dbml-native --all` prints every diagram;
  - `node dist/cli.js diff --project test/fixtures/dbml-native --domain test/fixtures/dbml-native/.erd-studio/gold/sales.dbml --no-dbt` exits 0;
  - manual §9.7 checks 1 and 6 recorded.
- **Depends on:** S2 (S3 is not needed for reading, but follows in order).

### S5: Host write integration (editor pipeline)

- **Goal:** every canvas edit works on DBML diagrams through `applySubjectAreaEdit`, in one WorkspaceEdit and one undo step, with byte-preserving writes and a reconcile when VS Code applies only part of an edit.
- **Files:**
  - **New:** `src/services/fileWrites.ts`, `src/services/dbmlLibraryWrites.ts` (with ops folding, misplaced moves, cross-file duplicates, D20), `src/providers/applyFileWrites.ts`, `src/services/fsFileWrites.ts`.
  - **Changed:**
    - `src/services/logicalModelService.ts` (`planTableWrites`, `relationshipsFileFor`, `dbmlSnapshot`, `hasUnreadableRelationships`, `ensureDir` for library paths only, `saveTable`/`renameTable`/`deleteTable` through `writeFilesWithRollback`);
    - `src/services/libraryRelationships.ts` (`usesLibraryRelationships`, `dropRelationshipsTo`);
    - `src/providers/subjectAreaCodec.ts` (DBML render);
    - `src/providers/SemanticEditorProvider.ts` (§5.3: `applyFileWrites`, dirty check, settle pass, codec-aware `rewriteOtherSubjectAreas`, forced `home`, `routeAddedRelationships`, undo-flush regex, layout → panel mapping, D20 refusals, the remove-models delete follow-up with the D16 cascade; remove the S4 temporary refusal);
    - `src/providers/payloadValidation.ts` (`validateNewDbmlTableName`, called by the create handlers).
  - **Tests:** §9.5, including `test/unit/relationshipStateSpace.dbml.test.ts` (+ harness variant with the projection).
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npx vitest run test/unit/relationshipStateSpace.dbml.test.ts test/unit/semanticEditorProvider.dbml.test.ts test/unit/applyFileWrites.test.ts test/unit/dbmlLibraryWrites.test.ts`;
  - every existing `test/unit/semanticEditorProvider*.test.ts` passes unmodified;
  - manual §9.7 check 2 recorded, with the §5.8 fallback applied if needed.
- **Depends on:** S3, S4.

### S6: Lifecycle commands, creation paths and the default switch-over

- **Goal:** new projects are DBML by default (the one switch-over, §3.2), and every create, rename, delete, import, draw, example, organise, resolve and export path is storage-aware.
- **Files:**
  - `src/extension.ts`: `createDomain` (also writes a missing `layers.json`), `renameDomain`, `deleteDomain`, `setupSemanticDirectory`, `deleteLogicalModel`, `organizeModelLibrary`, `resolveDuplicateModel`, `addLayer` (`_relationships` refused as a layer name too);
  - `src/services/logicalModelService.ts` (`newTablePath` / `pathForNewTable` consult `projectStorageOf`);
  - `src/services/{newSubjectAreaWriter,modelLibraryOrganizer,duplicateModelResolver,syncPlanBuilder,dbtDraft,commandErrors,dbmlImportParse}.ts` (snapshot rollback and the settle step in `newSubjectAreaWriter`; the `use` check in Import);
  - `src/commands/{drawFromDbt,importDbml,openExampleDiagram,moveRelationshipsToLibrary,exportDiagram,exportAllDiagrams}.ts` (export refusal inside the semantic dir, default folder);
  - `package.json` (`when` clauses);
  - **existing tests updated for the switch-over**, each changed only to seed YAML evidence where its intent is the YAML/v6 path, or to assert DBML where its intent is "a new project": run the suite with the flip and update exactly the failures, which are expected among `test/unit/tableNaming.host.test.ts` ("no library folder writes v6"), `drawFromDbt.writes.test.ts`, `migrationService.test.ts`, `importDbml.test.ts`, `dbmlImport.test.ts`, `dbmlRoundTrip.test.ts`, `domainService.test.ts`, `domainTreeProvider.test.ts`, `extension.activate.test.ts`, `gettingStartedPanel.test.ts` and `semanticEditorProvider.integrity.test.ts`; the PR lists each changed test with its reason. `logicalModelService.test.ts` (empty `logical-models/`, YAML evidence) must need no change;
  - tests §9.6 (lifecycle), export and import cases.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `git diff --stat origin/develop -- test/unit` lists only new files and the switch-over tests named in the PR;
  - manual §9.7 checks 5 and 7 recorded.
- **Depends on:** S5.

### S7: Convert Project to DBML

- **Goal:** the migration (including mixed and half-converted projects), its offer and its `doctor` preview, applied through the reconciling helper.
- **Files:**
  - **New:** `src/services/dbmlConversion.ts`, `src/services/dbmlConversionFiles.ts`, `src/commands/convertProjectToDbml.ts`.
  - **Wiring:**
    - `src/extension.ts`: registration, `NO_LEGACY_ALIAS`, `setDbmlConversion`;
    - `src/providers/SemanticEditorProvider.ts`: `maybeOfferDbmlConversion` (YAML and mixed wording), suppression of the naming offer;
    - `src/commands/migrateNaming.ts`: apply through `applyFileWrites` so its "Nothing landed" assumption (`:383-385`) is replaced by the reconcile;
    - `package.json`: the command and menus.
  - **CLI:** `src/cli/doctor.ts` (`erd.storage`, `erd.dbmlConversion`, `finish-dbml-conversion`, the `namingMigration` condition), `src/cli/format.ts`.
  - **Fixtures:** the library-relationships variant fixture for the golden test; a mixed-project fixture and a half-converted fixture for `dbmlConversion.test.ts`.
  - **Tests:** §9.6 (Convert), and the reconcile case in `migrateNaming*.test.ts`.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npx vitest run test/unit/dbmlConversion.test.ts test/unit/dbmlConversion.golden.test.ts test/unit/dbmlConversion.dbtProject.test.ts test/unit/convertProjectToDbml.test.ts`;
  - manual §9.7 checks 3 and 4 recorded, with the undo wording adjusted to what was observed.
- **Depends on:** S6.

### S8: CLI, MCP, harness, CI and the end-to-end script

- **Goal:** every outside reader and writer speaks DBML, assistants on old helper files are caught, and CI proves the whole chain.
- **Files:**
  - **CLI:**
    - `src/cli/{doctor,inventory,diff,args,format}.ts` (the rest of §7.1: `dbmlProblems` with severities, next steps, `update-harness` over every target, `'newer'`, `fix-dbml-file` FixKind, format-aware `turn-round-relationships`);
    - `test/unit/cli.noVscode.test.ts` (inverted, one parser copy);
    - `test/unit/cli.*.test.ts`.
  - **MCP:** `mcp-server/src/tools/{read_domain,list_domains,list_models,read_model,get_editor_setup}.ts`, `mcp-server/src/lib/setup.ts`, `mcp-server/README.md`, `mcp-server/test-smoke.mjs`.
  - **Harness:**
    - `src/services/harnessService.ts` (`SCHEMA_CONTENT` split into skill + `DBML.md` + `LEGACY.md` for the `claude`/`agents` targets, full inline for the single-file targets, `SYNC_CONTENT`, generators, `FileState` `'newer'`, `detectStale`, `HARNESS_VERSION = '35'`);
    - `src/harness/claude/erd-studio-setup/**` (§7.3, the named line replacements), `src/harness/CLAUDE.md`, `src/services/harnessAssets.ts` if a reference file is added;
    - regenerated `test/fixtures/dbt-project/.claude/skills/erd-studio/{SKILL.md,SYNC.md,DBML.md,LEGACY.md}`;
    - `test/unit/{harnessService,harnessAssets,fileSchemas}.test.ts`.
  - **CI and e2e:** `scripts/e2e-dbml.mjs`, `scripts/convert-fixture.ts`, root `package.json` (`test:e2e:dbml`), `.github/workflows/ci.yml` (`--no-build` after the existing build), `test/unit/dbmlPerformance.test.ts`.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `npm run build && npm run test:e2e:dbml -- --no-build`;
  - `cd mcp-server && npm run build && node test-smoke.mjs`;
  - `node dist/cli.js doctor --project test/fixtures/dbt-project --json --no-dbt` shows no `update-harness`;
  - for each of `dist/cli.js`, `dist/extension.js` and `mcp-server/dist/index.js`: `grep -o UNEXPECTED_ELEMENT_DECLARATION <file> | wc -l` prints the count of one parser copy (record the baseline in the test, not a literal 1, since the marker may occur more than once inside one copy), unchanged between the three;
  - `npx @vscode/vsce ls --no-dependencies | wc -l` ≤ 60.
- **Depends on:** S7.

- **D25 (added 2026-10-28):** `SCHEMA_CONTENT` (and the DBML companion) tells AI helpers to put properties inline and not to write `Metadata` blocks; `doctor` surfaces the Metadata-target error as a warning.

### S9: Docs, UI copy and release notes

- **Goal:** everything that describes storage says DBML, and the release is described as 2.0.0.
- **Files:** every item in §8.1; `CHANGELOG.md` (§8.2); `packages/core/CHANGELOG.md`, `packages/renderer/CHANGELOG.md`, `packages/core/README.md` (§8.3); `package.json` copy; `media/walkthrough/new-diagram.svg`; `src/types/gettingStarted.ts`; `webview/components/EmptyCanvas/EmptyCanvas.tsx`; `src/extension.ts:1533`; `scripts/social-preview.html`; `packages/core/src/exportDiagram.ts:4` (comment); `docs/dev/feedback.md` and `test/unit/feedbackRedaction.test.ts`; the issue-to-pr references. Test updates: `claudeMdPointers`, `uiWording`, `gettingStartedPanel`, `EmptyCanvas`, `logicalOnlyApp`, `extension.activate`, `release`, `feedbackRedaction`.
- **Acceptance:**
  - `npm run compile && npm test`;
  - `grep -rn "open standard" README.md docs package.json src/types/gettingStarted.ts src/harness src/services/harnessService.ts | grep -v "^docs/plans/" | grep -v "^docs/dev/onboarding-and-cli.md:"` returns only the existing Agent Skills sentence (the wording rule line and the Agent Skills sentence in `onboarding-and-cli.md` are excluded by file; check that file by eye);
  - `grep -rn "only storage\|stay the only\|stays the only\|the only copy\|never a runtime dependency" docs packages src/services/harnessService.ts src/harness | grep -v "^docs/plans/"` returns nothing;
  - `node scripts/release.mjs changelog --dry-run` (or the equivalent `release.test.ts` case) accepts `## Unreleased — 2.0.0`.
- **Depends on:** S8.

### After S9: the PR

Open one PR into `develop`, titled "ERD Studio 2.0: native DBML storage". **Never merge.**

The body lists:

- the decisions D1–D24, and Liam's answers to the open questions (Appendix);
- the outcomes of the manual checks;
- every existing test changed by the S6 switch-over, with its reason;
- the `migrateNaming.ts` reconcile fix (S7), called out as a behaviour fix to an existing command;
- the `dist/webview.js` and `dist/cli.js` size deltas;
- the Worker-deploy-first note;
- the Confluence follow-up (§1);
- the media needing a re-shoot (`demo.gif`, `readme-workflow.png`, `how-it-works.mp4`, the getting-started mp4);
- the breaking items called out for a major (§8.2).

---

## Appendix: open questions for Liam (answered)

Liam answered all three on 2026-10-28. The spec above implements the answers.

1. **Parser pin: 10.3.1 or 11.0.0?** **Answer: 11.0.0** (the spec's default was 10.3.1). Core gets the exact runtime dependency `"@dbml/parse": "11.0.0"` and the root pin moves from 10.3.1 to 11.0.0 in the same stage, S2 (D13, §4.1 "Parser pin"). The writer still writes only quoted string values, so DBML 9.x and 10.x tools read every file ERD Studio writes (§2.2 rule one); the reader also accepts 11.0's unquoted numbers and booleans (`natural_key: true`, `scd_type: 2`), keeps them byte for byte and flags them with `unquotedValue` (§2.2, §7.1). Tests read every written file with 9.1.1 (`dbml-parse-v9`), 10.3.1 (new `dbml-parse-v10`) and the pinned 11.0.0; the `dbml-parse-v11` alias is removed. Import DBML reads with 11.0.0, which only widens what it accepts (§4.1). The "quote the value" hint keys on 11.0.0's codes (`3025`, `3075`, and `3051`/`3063` in diagrams) with an example that is still an error there (`grain: 'One row per order line'`); `3073` is dropped from it. The fixed virtual path stays, for path independence and the 10.3.1 test alias; ERD Studio itself no longer has the space-in-path problem, and `doctor`'s `pathWithSpace` warning stays for other 10.x tools. `SCHEMA_CONTENT` still makes quoting its first table rule, for portability.
2. **FK-side `?` marks (D18).** **Answer: as the default.** Every Ref ERD Studio writes marks the FK end possibly null (`>?`, `?-`, `<>?`), so no file claims a NOT NULL foreign key it does not know, and the mark also fixes a one-to-one's direction.
3. **Selective `use { table x }` lines (D17).** **Answer: as the default.** Selective lines for tables, so two tables declaring the same Enum never break the files that import both; Enums do not travel into diagrams (a column keeps its type name). `use *` stays only for relationships files, and the reader still accepts `use *` for tables.

## Appendix: review log

Three reviews (compat-data-loss, architecture-feasibility, product-ai-cli) were checked against the code and the parsers. Verified in this revision: VS Code's non-atomic `applyEdit` with file operations (`index.d.ts:13313-13315`); `fullStart` covering leading comments and the file header (probe `q14-review.js`); the BOM `[1000]`; `use *` importing Enums and selective `use` avoiding it in all three parsers (with quoted, keyword and schema-qualified names); `[4000]`/`[3003]`/`[3060]` for constructs in a blanked diagram; `>?`, `?-`, `<>?` in all three parsers; `detectSubjectAreaFormat` returning `hybrid` for v5 names at version ≥ 6 (`semantic.ts:534-541`); `packages/core/build.mjs` being a single-entry build; `@dbml/parse`'s `.d.ts` importing the uninstalled `monaco-editor-core`; the rename ops shape (`SemanticEditorProvider.ts:3985-3991`); `listTables` bypassing `getTable` (`logicalModelService.ts:757-797`); private `newTablePath` and library-only `ensureDir`; `nextCompositeKey` living in the host; the empty-`logical-models/` rule in `projectNaming.ts:52-58`; `doctor` checking only `harness.claude`; `fileState` calling a newer marker `outdated`; the setup skill's line numbers.

**Accepted** (every item not listed below was accepted in full; the section that resolves it is given):

| Review | Items, each with the section that resolves it |
|---|---|
| compat-data-loss | 1 (D23, §5.3, §6.1 resume, §6.5 `finish-dbml-conversion`), 2 (§6.1 step 3, named refusal), 3 (D24, §2.8), 4 (D3, §2.4, §4.6), 5 (§2.3, §2.4, §4.6 step 5), 6 (D6, §2.5, §4.3), 7 (D1, §2.1, §3.5), 8 (§2.1), 9 (D2, §3.4), 10 (D9, §3.2, §3.5 `firstLine`, §5.7 export), 11 (D20, §4.5, §4.6), 12 (§6.1 `replaces`), 13 (§4.5 cut rule, `headerEnd`), 14 (§2.1 BOM), 15 (§7.6), 16 (§2.1), 17 (§2.4, §4.5 `resolve().reference`), 18 (§4.5 rewrite rule, §6.1 refusal), 19 (§3.3, §7.3), 20 (D18), 21 (§5.9), 22 (§5.1, `writeFilesWithRollback`), 23 first half (§2.8, §6.1 step 3) |
| architecture-feasibility | 1 (§3.2, S6), 2 (D8, §4.3, §5.2), 3 (D13, §4.1), 4 (D12, §4.1 rules 5–6, §9.2), 5 (D20), 6 (§4.6 step 0), 7 (§5.1 `readTableEntry`), 8 (D24, §9.2 goldens, §7.6 e2e), 9 (§2.1, §3.4, §6.1 step 8), 10 (§6.1), 11 (D17 selective `use`; severity in the rejected list), 12 (§4.6 step 3), 13 (D7, §4.5 Law 1), 14 (§9.5), 15 (§3.4), 16 (S4), 17 (§2.4, §4.1), 18 (§4.4 not-a-diagram), 19 (§5.1 `pathForNewTable`), 20 (§4.1, S2), 21 (§5.1), 22 (§5.4), 23 (§4.1, §4.3), 24 (§4.5 rename, §4.6, §5.7), 25 (§4.6 `incoming`), 26 (§4.7, S1), 27 (§5.7), 28 (§4.5), 29 (§3.3) |
| product-ai-cli | 1 (§3.6, §5.4 toast, §7.1 `update-harness` / `'newer'`), 2 (§7.3 item 1), 3 (§2.2 rule one, §4.3, §4.7), 4 (§2.2), 5 (D4, §2.5), 6 (D3, §2.3 one-to-one rule, §7.3 item 5; the keys-first part changed, see below), 7 (§4.1 virtual root, §7.1 `pathWithSpace`, Goal 1, §8.2), 8 (§6.2, §6.4), 9 (§6.1, §6.4), 10 (§7.3 named lines), 11 (§7.3 companion files), 12 (§4.3 `mergeConflict`, §7.1), 13 (§7.1 severity table), 14 (§2.5 banner, §5.7 Import), 15 (§2.3), 16 (S9 greps, §8.1), 17 (§3.3), 18 (§7.4), 19 (§5.7), 20 (§2.5 `placeUnlaidNotes`, §5.6, §8.1, §7.6) |

**Rejected or partly rejected** (one line each, with the reason):

- **compat-data-loss 23, second half** ("apply Import's role rule to Refs ERD Studio did not write, since Import keeps only known roles for foreign files"): rejected. Import keeps **any** Ref name as the role (`dbmlImport.ts:1023`, `normaliseRelationshipRole` in `packages/core/src/relationships.ts:207` has no known-roles filter), and a stored file cannot tell who wrote a Ref; the rule is documented instead ("name a Ref only to give it a role", product-ai-cli 15). The first half (first member's role with a note, no refusal) is accepted.
- **compat-data-loss 7, "Convert refuses (or renames) diagram stems starting with `_`"**: not needed. With only `_relationships` reserved, a `_x.dbml` in a layer folder is a diagram (§3.5), so `_x.json` converts as is.
- **architecture-feasibility 11, "make `doctor` an error-level check" for duplicate Enum names**: partly rejected. ERD Studio now writes selective `use` lines (D17), so a duplicate Enum breaks only a hand-written `use *` file, and that file's own compile error is already reported at error level by `compileDbmlProject`; the standalone `duplicateEnum` check is a warning so it does not raise `fix-dbml-file` for files that compile.
- **product-ai-cli 6, "for `-`, choose the FK side by keys (`orientLink`) before falling back to position"**: changed. Keys alone misread the shared-primary-key one-to-one the writer itself writes (the FK is its table's whole key, the other end is not), which would break Law 3. The `?` mark the writer puts on the FK end decides first; keys decide only a bare or doubly-marked `-` (Import's foreign-file rule), then position (§2.3).
- **product-ai-cli 7, "the planned doctor check for a table name with a space is moot, `TABLE_NAME_PATTERN` rules it out"**: rejected. Only names created in ERD Studio follow `TABLE_NAME_PATTERN`; names from the user's dbt project are whatever dbt allows (`payloadValidation.ts:28-32`), so a table file name can hold a space. The check is kept and widened to the project path (`pathWithSpace`). The rest of item 7 is accepted.
- **product-ai-cli 7, "reconsider pinning core to 11.0.0"**: accepted after Liam's answer (open question 1): the pin is 11.0.0 (D13).
- **compat-data-loss 15, "document or consider a split rule"**: the documentation part is accepted (§7.6); an automatic split rule is out of scope for 2.0, because library folders already split the file and any automatic rule would move Refs between files on its own.
- **product-ai-cli 1, "a 2.0 watcher check" scope**: accepted as a toast only. The extension never converts or deletes the file an older helper wrote; Convert (mixed wording, §6.4) and the harness update are the fixes.

**Revision after Liam's answers (2026-10-28).** Liam answered the three open questions: parser pin **11.0.0**, FK-end `?` marks as the default, selective `use` lines as the default. The spec was made consistent with 11.0.0 everywhere (D13, D17, D18, Goal 6, §2.2, §4.1, §4.3, §4.5 Law 5, §4.7, §6.1, §7.1, §7.3, §7.6, §8.1–§8.3, §9, S1, S2, both appendices). Verified with scratch probes against this worktree's `dbml-parse-v11` (11.0.0), `@dbml/parse` (10.3.1) and `dbml-parse-v9` (9.1.1): 11.0.0 accepts unquoted numbers and booleans (including `TRUE`, `-2`, `1.50`, `1e3`) on Tables, columns and Notes as `{value, type: 'number'|'bool'}` and still rejects unquoted words, phrases and `null`; Project custom keys stay plain strings and must be quoted in all three; the value-error codes are `3025`/`3075`/`3051`/`3063` in 10.3.1 and 11.0.0 but `3025`/`3073`/`3049`/`3061` in 9.1.1, and `3073` is a TablePartial error in 10.3.1 and 11.0.0 (read from each package's error-code enum); 11.0.0's `filepath` JSON is `{root, segments}` while `Filepath#absolute` works in all three; the `use` AST and every offset are identical in all three; 11.0.0 keeps tables under a path with a space, where 10.3.1 returns `tables: []` with no error; an attribute token spans `key: value`, so a typed literal's text is recoverable; the 28 `.dbml` fixtures and goldens and the coffee-shop example parse with no errors in all three; the two parsers bundle to about 433 KB and 435 KB minified, each with the marker string 3 times (so §4.1 rule 5 no longer says "occurs once").

- 2026-10-28 (orchestrator, Liam's decision): added D25 — `Metadata` blocks in hand-written table files are edited in place by the writer (§4.5.x), with a precise load error for a missing target (§4.7), tests (§9.3) and a SCHEMA_CONTENT line (S8). Sidecar metadata files rejected. Source: peer-session probe of 9.1.1/10.3.1/11.0.0.
- 2026-10-28 (S1 implementation): deviations and additions, each minimal.
  - **Webview wording deferred to S4.** The `webview/App.tsx` / `Toolbar.tsx` "isn't valid JSON" and "Open as JSON file" texts (§4.7 fallouts) need the host to send the file type; no `.dbml` diagram reaches the webview before S4, so S4 makes that change with the canvas read path. Every other §4.7 fallout is in S1.
  - **Two existing tests not named in S1 changed**, because they pin text or values S1 changes by design: `packages/core/test/unit/tableNaming.test.ts` (asserted `CURRENT_SCHEMA_VERSION` 6; now 7, plus `CURRENT_JSON_SCHEMA_VERSION` 6) and `packages/core/test/unit/libraryRelationships.test.ts` (a regex on the old "logical-models/ defines it as" text).
  - **Parser-free error plumbing in the main entry.** `dbmlErrorClassOf(code)` (the code-range rule, so S2's `parser.ts` reuses it instead of its own `errorClassOf`), `TableDbmlError` and `classifyDbmlTableError` (what `classifyTableLoadError` classifies for a `.dbml` table file), `DBML_TABLE_QUOTE_HINT_CODES` (`3025`, `3075`), `DBML_DIAGRAM_QUOTE_HINT_CODES` (`3063`, `3051`) and `DBML_QUOTE_HINT` live in `domain.ts`.
  - **`editDiagramLayout` refuses with `DbdiagramLayoutRefused`** (main entry), since the main entry may not use the subpath's `DbmlEditRefused`. `placeUnlaidNotes(noteIds, positions, stickies)` returns a place per unlaid id; it assumes the canvas defaults (table 280 px wide, note 160 × 80).
  - ~~The comparator also removes a shared indent~~ (corrected in the S1 review, round 1: the writer emits `dbmlNoteText(text)`, whose first line has no indent, so DBML's shared-indent trim never applies and a dedent made indented bullet lists compare unequal after a correct round trip; `storageNoteText` is now exactly `dbmlNoteText`, and §2.8's first row says so). Annotation coordinates and sizes are rounded like positions.
  - **Tests that need host code are host tests**: `toSubjectAreaSlug` and the reserved name in `test/unit/reservedTableName.test.ts`, the re-export identity of `nextCompositeKey` and `ERD_STUDIO_DBML_HEADER_PREFIX` in `test/unit/coreReexports.test.ts`, the §4.7 host fallouts in `test/unit/dbmlErrorFallouts.test.ts`, and the renderer's DBML node text in `packages/renderer/test/unit/ModelNode.dbmlLoadError.test.tsx`.
  - **Two more host wordings** say "DBML error" for a `dbml*` kind: the Table Library item description and the canvas's "Can't edit" refusal (`ModelLibraryTreeProvider`, `SemanticEditorProvider.tableUnavailableMessage`).
  - **Changelogs** are left to S9 (§8.2, §8.3), which writes the core 0.4.0 lines for everything S1 added or changed.
- 2026-10-28 (S1 review, round 1): fixes and decisions.
  - **Comparator** (`storageEquivalence.ts`): note text is `dbmlNoteText` only (see the corrected S1 entry and §2.8); with `convert`, a Unified diagram's own `logical.relationships` are moved to their owners **and the list is emptied** (D5: a DBML diagram holds no Refs); without `convert`, a link stored in both ends' files is no longer deduplicated (that row is Convert-only), so Law 3 and the twin goldens catch a writer that double-stores a link.
  - **`editDiagramLayout`**: a missing `tablePositions` / `stickyNoteLayouts` list, or a missing `defaultView`, counts as `[]`, so a no-op edit of an older or hand-written layout file writes nothing (D7).
  - **`isReservedTableName`** trims, as `sameName` does; the classifier keeps comparing the listed stem untrimmed.
  - **Host DBML hints** depend on the code (§4.7 fallouts reworded): quote advice only for `3025`/`3075`; `dbmlStructure` advice per rule; never `use`/`Ref` advice.
  - **Kept:** `describeTableLoadError` still says "logical-models file could not be read" for a `read` failure of any table file. The `read` kind carries no format, and S1 changes YAML-visible text only at `:659` and `:826` (§4.7); S4, which first reads `.dbml` table files in the host, may make it storage-neutral with its golden.
  - The §4.7 webview fallouts deferred to S4 are now in S4's file list (§10).
- 2026-10-28 (S2 implementation): deviations and additions, each minimal.
  - **`attachRelationships` is in the main entry** (`packages/core/src/dbmlAttach.ts`, parser-free, with `dbmlTableLookup` and `relationshipsFileFolder`), re-exported from `@erd-studio/core/dbml`, not in `dbml/readRelationships.ts`: `loadDisplaySubjectArea` (main entry) calls it and may make no value import from `./dbml/` (§4.1 rule 2), and the host calls the same function. `libraryCopyRank` is factored out of `mergeLibraryRelationships` so both dedupe with one ranking.
  - **Two comparator rows added to §2.8** (the order of relationships; an empty sticky-note list). Without them no twin whose YAML case held relationships in its diagram file, or an empty `annotations` list, can compare equal, since a relationships file sorts its Refs. The S1 tests still pass; each row has its own test.
  - **Host-side twin and error-golden checks move to S4**, because the host reads no DBML before S4. In S2, core's `loadDisplayDomain.golden.test.ts` holds the five twins and the four new error goldens (`errors.dbml-syntax`, `-future`, `-conflict`, `-not-a-diagram`). The goldens are hand-written in the host's posted shape. `displayDomainGolden.test.ts` only lists them in `EXPECTED_FILES`; S4 adds them to its `ERROR_CASES`, and its host wording may regenerate the `dbml-syntax` message, which core does not compare (it compares the reason, line and column).
  - **`library-relationships`** compares equal to its YAML golden through the comparator on the Display shape: the domain file's disagreeing copy shows only in the Unified shape. So S2 holds it to `library-relationships.host.json`, and the own flat goldens `dbml-library-relationships.host.json` / `.unified.json`, which are about the Unified shape, come with the host in S4.
  - **`missing-model` twin exception** (the test names it, with the reason). The diagram file's two relationships are owned by `dim_missing` (no file) and `broken` (a table file that does not parse). DBML cannot hold them, because only a readable DBML owner's Refs attach (§2.4). `broken`'s load error is a DBML one (`dbmlSyntax`, line 5, code `1005`). `nameless.yml` (YAML with no name) has no DBML twin, so its table is simply absent. These changes are made to the YAML golden before the comparison.
  - **`exportDiagram.golden.test.ts` has no `ERROR_CASES`**, so the error goldens are checked only by the loader's golden test. The twins are added there as parser checks without goldens: their exports list relationships in the sorted order, so they are not byte-equal to the YAML exports.
  - **The twins are hand-written** (drafted by a scratch script from the §2.2–§2.6 rules) without Convert's `// Kept from …` comment blocks. S7 makes them byte-equal to Convert's output, except `missing-model` (§9.6, S2 review round 1).
  - **`parseSubjectAreaDbml` refuses with `invalid-dbml` when a binding error is left after blanking.** §4.3 step 4 calls it a warning, but the parser gives no `rawDb` when any error is present, so there is nothing to read. Only a construct ERD Studio does not know can cause it.
  - **A DBML table's `loadError` carries `code` (and `target` for D25)** into the display. YAML load errors keep `kind` / `line` / `mergeConflict` only, unchanged. `maxRelationshipsChars` counts as a limit for the `ignoreStrayPositions` default, like the other limits.
  - **Acceptance commands.** `require('@dbml/parse/package.json')` and `require('dbml-parse-v10/package.json')` throw `ERR_PACKAGE_PATH_NOT_EXPORTED` (both packages' `exports` leave out `package.json`), so S2 reads the versions with `require('./node_modules/<name>/package.json')`. Comments under `packages/core/src/dbml/` say "the DBML parser" instead of naming the package, because declarations keep comments and the `! grep -rl "@dbml/parse" packages/core/dist/dbml/*.d.ts` check is textual.
  - **`packages/core/build.mjs` reads `ERD_CORE_OUTDIR`**, so `test/unit/coreDistEntries.test.ts` builds with the one config into `node_modules/.cache` and loads the built entries for the `instanceof` check. The round-trip coverage test (`test/unit/dbmlRoundTrip.test.ts`) and the export coverage test skip the new `fixtures/dbml/` folder, as they skip `naming-*`.
- 2026-10-28 (S2 review, round 1): fixes and decisions.
  - **`Metadata` blocks in a diagram** are blanked, warned about and kept (§2.5, §4.3 step 3, D6). Without it a hand-written `Metadata Table t` in a diagram, valid DBML in a project compile, made the diagram `invalid-dbml` once the `use` lines were blanked. The S2 deviation "a binding error left after blanking refuses" stands, now that every construct that names a table is blanked (§4.3 step 4 reworded).
  - **`compileDbmlProject`** reports each diagnostic once across entries (a file two entries reach used to report it twice), and has its own test (`dbmlCompileProject.test.ts`, all three parsers): relative keys, an error keyed by the file it is in, BOM, duplicates, a library folder whose name holds a space (all three parsers keep the imported tables), and every clean twin compiling with no diagnostics.
  - **`attachRelationships` takes `partial`** (§2.4, §4.4 step 6): core's loader holds only the members, so it no longer reports a Ref whose owner is a table off the diagram (or one that did not read) as orphaned. The host leaves it unset.
  - **No `.dbml` under `tables/` is a diagram** in core, whatever `layers.json` says (§4.4 reworded to agree with §3.3 and the classifier); the test that read `tables/t.dbml` as a diagram when `tables` was listed now asserts the refusal.
  - **`usePathMismatch` in core compares the specifier with the stem without case** (D2); a wrong-case path needs a listing and is the host's and `doctor`'s (§2.5).
  - **The twin goldens enforce their row lists** (§9.2): the comparator's rows have ids (`StorageEquivalenceRow`, `normaliseStorageRows`, internal; the package entry now names the module's public exports instead of `export *`). The lists were corrected to what the Display comparison needs (the empty sticky-note list added for showcase and missing-positions; the Convert-only "link stored twice" and the Unified-only composite rows removed).
  - **`missing-model` is excluded from S7's byte-equality check** (§9.2, §9.6): its twin cannot be Convert's output.
  - The §2.3 operator, bare-`-`, block-form and qualified-end reader tests run under 9.1.1, 10.3.1 and 11.0.0; the tautological "path with a space" table-reader test now checks the fixed virtual path, and the multi-file case is in `dbmlCompileProject.test.ts`. `packages/CLAUDE.md` lists `@dbml/parse` as the runtime pin, not a devDependency.
- 2026-10-28 (S3 implementation): deviations and additions, each minimal.
  - **Index lines follow their columns.** A column rename also renames it in every `indexes` line that names it, and an index line that names a removed column is cut with it (the PK line is still governed by the PK-set rule). §4.5 says "other index lines are untouched", but an index naming a column that is gone or renamed fails to compile, which would break Law 5.
  - **A re-spelled Ref moves only when it must.** A Ref re-spelled for a rename stays in place unless its new sort key changes its order against the kept Refs beside it (§4.5 step 2 "moves only if its sort key changed"), so a rename of a table every Ref names does not reshuffle the file. Inserted Refs still go before the first kept Ref whose key is greater.
  - **`DbmlResolvedTable.primaryKey?`** (optional): with it, `editRelationshipsDbml` orients a bare `-` Ref by keys exactly as `attachRelationships` reads it (§2.3 case 2), so a hand-written FK-first one-to-one keeps its bytes when its owner is listed. Without it the writer tries both orientations against the desired units, so an unchanged Ref keeps its bytes either way (S3 review, round 1). The planner (§4.6, S5) is to pass it.
  - **Writer options beyond the spec's signatures.** `editTableDbml(oldText, desired, { rename?, file?, fileStem?, foreignMetadata?, parser? })`: `file` names it in messages, `fileStem` reads a file before a rename, and `foreignMetadata` lists the Metadata blocks in other files that target the table, which is how the D25 "set by a Metadata block in <file>:<line>; edit it there" refusal gets its input (the writer sees one file). Every writer takes the optional `parser`, like the readers. `renderNewSubjectAreaDbml` also takes `filePath`, and its members are `{ name, reference?, path }` with paths relative to the semantic dir, so it computes the `use` paths itself.
  - **A stale `use` path is repointed only by an edit that changes something** (or the settle pass, or a `pathChanged` table), so `editSubjectAreaDbml(t, read(t))` stays byte-identical on a diagram with a stale path (Law 1 holds for every writable file; §4.5's stale-path rule otherwise fires on a no-op).
  - **Meta is edited where it is held.** A changed entry already held in `meta_json` (and not as its own `meta_<key>`) is changed inside `meta_json`; only a new entry becomes `meta_<key>` (§4.5 "only the properties whose value changed are touched").
  - **Reordered columns keep the comments of a removed one.** When columns are reordered and one is also removed, the comment lines above the removed column are kept after the reordered ones (the cut rule, Law 4).
  - **Test helpers.** The writer cases live in `packages/core/test/dbmlWriterCases/{tableCases,relationshipsCases,diagramCases}.ts` and the shared helpers in `packages/core/test/dbmlWriterSupport.ts`: they are the "helper" through which `dbmlMultiParser.test.ts` compiles every writer test's output again (errors and warnings, through each parser's `DBMLDiagnosticsProvider`), holding each to the parsers its input compiled clean in. `dbmlCodecLaws.test.ts` adds two in-memory hand-written law projects (extra and missing `use` lines, unsorted Refs, `indexes { id [pk] }`, `primary key`, `erd_` names, a `meta_<key>` over `meta_json`, a Metadata block, an Enum) rather than a new folder under `fixtures/dbml/`, whose twin list `dbmlCompileProject.test.ts` pins; it also reads `test/fixtures/dbml-native/` once S8 adds it. The subpath also exports `applyTextEdits`/`TextEdit`, `relationshipUnits`, `refUnitSortKey`, `usePathBetween` and `DBML_CONVERT_FIRST_MESSAGE` for the host planner (S5).
- 2026-10-28 (S3 review, round 1): fixes and the deviations they record.
  - **A deleted member's `use` line is cut** (§4.5 table `use` lines, D16): a member in `pathChanged` that resolves to no table and whose file is gone loses its line, even when `after` still lists it (the S5 cascade re-renders diagrams through this writer). Comment lines above it stay.
  - **`before` must be what the text reads as.** `editSubjectAreaDbml` pairs members with their `use` lines by position, so it refuses a `before` whose members differ from the file's (a stale snapshot) instead of cutting the wrong line.
  - **A rebuilt `use` block moves each line with its comments**: the comment lines directly above it and its trailing comment (Law 4), as reordered columns do; a removed member's comment lines stay where they were.
  - **Link identity is order-free per pair** (CLAUDE.md: `linkKey` / `sameLink`): the relationships writer matches a composite listed with its pairs in another order as the same Ref (its bytes stay), and a regenerated composite keeps the file's pair order.
  - **A regenerated Ref with a renamed end moves like a re-spelled one** (§4.5 step 2), and a Ref that moves takes its trailing comment with it.
  - **A block-form Ref is regenerated in place**: only its ends, operator and name are spliced, so the comments inside the block survive (Law 4).
  - **`owners` is keyed by the owner's name after the edit**; a key that is a renamed owner's old name (or another spelling `resolve` maps) is read through `renamedOwners` and `resolve`. A Ref a listed owner's list describes from the other end (a `one-to-many` record) is matched like the owner's own instead of colliding with it.
  - **A new Ref to a table with no file is refused** (§4.5 step 4, Law 5): it would not compile, and a relationships file that does not compile reads as holding nothing. A dangling Ref already in the file, or carried in as `incoming`, is kept as it is.
  - **One bare-`-` rule.** `reverseBareOneToOne` (`dbmlAttach.ts`, exported) is the §2.3 case 2 rule `attachRelationships` and `editRelationshipsDbml` both call.
  - **`editTableDbml`'s `rename` means something.** Without `rename: true`, a name that differs from the declared one only in case keeps the declared spelling, and any other difference is refused; with it the name is spliced.
  - **Writers refuse instead of crashing.** A parser that throws on the table file is refused like a file that does not read, and an overlap of a writer's own edits (a writer bug) becomes a `DbmlEditRefused` through `refuseOverlaps` (`splice.ts`). Two such overlaps are fixed: a table rename that also removes a column with a `Metadata Column` block, and a column reorder that also moves to a composite key with a body `Note` among the columns (the new `indexes` block goes into the rebuilt region, before the Note).
  - **A one-line settings list with a block comment** is spliced element by element, so the comment survives (Law 4); one without stays rebuilt as before.
  - **Law 4 is tested on tokens**: every `//` and block comment of the input outside the cut span of a node the edit removes is still in the output, and named constructs ERD Studio does not model (an Enum, DBML-only settings, other index lines, a Metadata block, the Project's unknown keys, a `use *`, typed values) survive wherever their node stays. The generators now decorate relationships files (comments, trailing comments, block-form Refs) and diagrams (comments on `use` lines and Notes), rename tables, write `Metadata` blocks, move the body Note among the columns, add block comments, and list composites with their pairs reversed; the relationships generator skips only `DbmlEditRefused` and asserts how many cases ran. The hand-written law project holds an 11.0-only typed-value table (held to 11.0.0 by Law 5), and `renderNewTableDbml` is checked over every YAML fixture table (read back and compiled in all three parsers). The writer tests' inline outputs moved into the case lists, so `dbmlMultiParser.test.ts` compiles them too.
- 2026-10-28 (S4 implementation): deviations and additions, each minimal.
  - **Two acceptance commands as written cannot pass, so S4 runs their closest equivalents.** `export … --all` without `--format` is a usage error (exit 2: `--format` has no default), so S4 runs `export --project test/fixtures/dbml-native --all --format <f>` for each of the four formats (all exit 0 and list both diagrams). `diff` has no `--no-dbt` option and needs a dbt project, while §7.6 makes `dbml-native` logical-only, so the literal command exits 2; S4 instead holds `cli.diff.test.ts` "end to end on native DBML storage": a copy of `dbt-project` whose logical model is written as DBML (`renderNewTableDbml`, `editRelationshipsDbml`, `renderNewSubjectAreaDbml`) from `inventory`, and `diff --domain .erd-studio/silver/orders.dbml` exits 0 with every relationship matched (and `diff --all` too). S8 may give `diff` a logical-only answer; the acceptance line should then be revisited.
  - **`doctor` gains `erd.storage` and `erd.diagrams`** (`[{file, format}]`, additive) in S4, so "lists every diagram" is checkable; §7.1's other doctor fields stay S8. Human output adds "storage DBML" (and "storage mixed, …"), and keeps the YAML line as it was.
  - **Moved earlier from S8**, because `listSubjectAreas` lists `.dbml` diagrams from S4: `cli.noVscode.test.ts` is inverted (the CLI bundles the root `@dbml/parse`, never a test alias), and `inventory` reads members through `subjectAreaTableNames`. Delete Subject Area also deletes the diagram's `.dbdiagram` (§5.7). Organise Table Library and Give Duplicate Its Own Name leave `.dbml` tables alone, and Rename Subject Area refuses a DBML diagram, until S6 writes them. `usesLibraryRelationships`' DBML clause (write routing) and `relationshipsInLibrary` stay S5; `context.ts` needs no change (doctor calls `projectStorageOf` directly).
  - **Table writes are refused too.** Besides the diagram refusal ("Editing DBML diagrams is not available yet…", `EditRefused` before any mutation), `TableLibraryService` refuses every write to a `.dbml` table (`DbmlTableWriteRefused`, an explained refusal for telemetry), so a JSON diagram in a mixed project cannot regenerate a DBML table as YAML. The ready load never persists a DBML diagram's computed positions (layout writes are S5).
  - **The codec's shape.** `parse(text, filePath, layoutText?)` throws core's errors (and `NotASubjectAreaObject`); the provider words them as before (`EditRefused`). `render(p, text, filePath)` takes the file path instead of a resolver until S5 adds one; the DBML codec's `render` throws. The v6 `WeakSet` and `serialiseSubjectArea` moved into the codec module.
  - **Host goldens.** `errors.dbml-*` join the host's `ERROR_CASES`. `errors.dbml-not-a-diagram` gains `kind: 'not-a-domain'` (the page with Open as Text, which §5.9 asks for a `git:` table file; core's test reads that as a `SubjectAreaValidationError`, unchanged). `errors.dbml-syntax` is regenerated in the host's wording ("has a mistake at line L, column C: <parser message> [code].") with the additive payload field `fileType: 'DBML'`, which the webview's "isn't valid <JSON|DBML>" reads (the payload carries no file path). The host twin checks compare the posted Display through each case's rows, and the Unified shape through rows (showcase and missing-positions add `convertDiagramRelationships` + `convertLinkStoredTwice`, since a DBML diagram's library relationships are drawn into the stage's list) or, for `missing-model` and `library-relationships`, through own goldens `dbml-missing-model.unified.json` and `dbml-library-relationships.unified.json`.
  - **Listing and lookup details.** `findTableFile` matches the listing per candidate directory (exact spelling first, then any case), for YAML too, so the listed spelling is returned on every file system. Within `tables/`, any pair involving a `.dbml` is matched without case for shadowing; YAML pairs stay exact. JSON diagram listing keeps its old rule (every `.json` in a layer folder) except in a DBML-library `tables/`; `.dbml` diagrams go through the classifier with their first line.
  - **The foreign-format toast** compares against the storage the `erdStudio.storage` key last held: the created `.yml` or `.json` itself makes the project `mixed`.
  - **Import DBML takes a file URI** (the banner's `importEmbeddedTables` runs it on the canvas's own file); from the palette it still asks for a file.
  - **Manual checks 1 and 6** have automated stand-ins (`semanticEditorProvider.dbmlRead.test.ts` reroute rows for `file:` and `git:`, and `dbmlManifest.test.ts` for the `.dbdiagram` language); the dev-host runs stay for the PR.
- 2026-10-28 (S4 review, round 1): fixes and two decisions.
  - **The attachment memo** (§5.1) is keyed on the relationships files' signatures, the listed table files and a generation counter that every change to a table cache entry bumps (a read that finds a file changed, a drop, `invalidateCache`). A quick key checked first holds the same relationships signatures, `layers.json` and every library directory's own `mtime:size` (an add, remove or rename changes it), so a memo hit is a few stats and no listing. A table edited in place and not yet re-read is picked up by the watcher's invalidation or by its next read, which is what "memoised against the set of cache keys" means here. `listTables()` attaches once per call.
  - **`lineAt` indexes line breaks** (core, internal): reading a 30,000-Ref relationships file asked for every Ref's line by scanning from the start, about 15 s; now about 1.3 s.
  - **`test/unit/dbmlPerformance.test.ts` starts in S4** with the two read budgets of §7.6 at the spec's size (10,000 tables, 30,000 Refs; measured about 3.4 s cold and 0.9 s for a warm 50-table canvas load). Each budget fails above 3× (the CI margin) and prints any time over it. S5 adds the relationship-edit budget.
  - **Until S5:** a DBML diagram asks for no ELK pass (its position save would be refused), and the canvas's Delete Table File never offers a `.dbml` table (its D16 cascade comes with the writes). The foreign-format toast skips a path New Diagram or Rename marked as their own. A layout event carries `layout: true`, and only it redraws the canvas from the watcher.
  - **Deferred, not changed:** the Export Save As refusal inside the semantic dir stays in S6 as §5.7 and §10 schedule it; the branch ships as one PR, so no build between S4 and S6 is released.
- 2026-10-28 (S5 implementation): deviations and additions, each minimal.
  - **The YAML/JSON path keeps its WorkspaceEdit.** `applySubjectAreaEdit` takes the new path (`planTableWrites`, codec render, settle pass, `applyFileWrites`) when the diagram is DBML, the library holds a DBML table or relationships file (`hasDbmlLibrary`), or an `otherDomains` rewrite would reach a DBML diagram. A pure YAML/JSON project keeps today's `addTableFileEdits` shape, a rename's create + delete included (§5.3 sent that through `applyFileWrites`): the existing provider tests pin its op order, and S5 must leave them unmodified. A mixed project's YAML writes go through `applyFileWrites` with the DBML ones.
  - **Cross-file duplicates (§4.6 step 5) are checked for the links this plan writes.** A link held twice that the plan does not touch (already a reader warning and a `doctor` report) does not block an unrelated edit; a link the plan inserts, regenerates or moves that is still held elsewhere after the plan is refused, in two files or twice in one.
  - **The snapshot's table entry** carries `primaryKey` and `dbmlAlias` besides §4.6's fields, so the planner orients a bare `-` Ref by keys and resolves an aliased end exactly as `attachRelationships` does (the S3 note on `DbmlResolvedTable.primaryKey`). Planner paths are posix and relative to the semantic dir; `planTableWrites` returns absolute paths.
  - **The primary diagram refreshes its relationships `use` lines** when the plan creates the relationships file of one of its members' folders (the settle pass covers only the other diagrams).
  - **Not computed yet: `foreignMetadata`** (D25 blocks in another file targeting a table). The planner passes none, so a property set by such a block is edited inline and the block still wins on read. ERD Studio never writes one; `doctor` (S8) can report them.
  - **Delete Table File** offers every table file again; for a `.dbml` table the prompt adds "This removes the table's file, its N relationships and its place in M other diagrams." and runs the D16 cascade (`planDbmlLibraryWrites` with `dropRelationshipsTo` saves for DBML owners, plus a codec re-render of every DBML diagram listing it) as one `applyFileWrites` edit. JSON diagrams that list it are left as today (a placeholder). The `deleteLogicalModel` command is S6 (brought forward for `.dbml` tables in the S5 review, below).
  - **S4 tests that pinned the temporary refusals were rewritten**: `semanticEditorProvider.dbmlRead.test.ts` (an edit writes; a fresh layout asks for ELK; Delete Table File runs the cascade) and `logicalModelService.dbml.test.ts` (saveTable / renameTable / deleteTable write DBML). No pre-branch test changed. The vscode mock gained `applyEditPrefixes` (additive) to apply a prefix of an edit.
  - **`relationshipStateSpace.dbml.test.ts`** projects the main universe's states (`relationshipStateSpace.dbmlHarness.ts`: `dim` at the top of `tables/`, `fct` in `tables/gold/`, diagrams `silver/D1..D3.dbml`) and checks one link per key, FK ownership, home-folder placement, representability against the planner's decision for the projected world, Law 5 on every file and Law 4 on the table files; Laws 1–3 are core's (S3). The group and self universes are not projected (added in the S5 review, below). CI samples every 151st small-scope state (about 750 runs, 10 s; `STATESPACE_DBML_EVERY=1` for all), with a floor of 300 runs.
  - **`addModelsFromDbt`** is covered through `addExistingModels` (both are `applyDbtModels`); the dbt picker is not driven.
  - **Manual check 2** has an automated stand-in for the flush half (rewinding the documents and pressing the toolbar's Undo puts every file back, layout files included); VS Code's own undo stack for a layout-only edit, and a rename's file operations, stay a dev-host check for the PR. The §5.8 fallback (`lastEditLayoutOnly`) is not built: a layout-only edit is grouped with an identical-text replace of the diagram, the mechanism YAML table edits already rely on.
  - **The relationship-edit budget** (§7.6) is in `dbmlPerformance.test.ts`: `planTableWrites` for one owner over the 30,000-Ref file, measured about 1 s.
- 2026-10-28 (S5, manual check 2 recorded): run in a real VS Code 1.139.1 dev host rather than by hand. A throwaway harness (not committed) launched VS Code with `--extensionDevelopmentPath` (a copy of the S5 build whose only change exposes each panel's webview message handler) and `--extensionTestsPath`, on a copy of `test/fixtures/dbml-native/`, opened `gold/sales.dbml` in the custom editor with the real webview loaded, and sent the canvas messages for (a) a drag (`updatePositions`, writes only `gold/sales.dbdiagram`), (b) a column edit (`updateColumn` on `fct_order`, writes `tables/gold/fct_order.dbml`), (c) a relationship add (writes `tables/gold/_relationships.dbml`) and (d) a rename (`dim_region` → `dim_area`: the table file renamed, the diagram, its layout and the relationships file rewritten). Each was undone twice over: by the toolbar's Undo message and by VS Code's own `undo` command, the command Cmd+Z runs, with the canvas the active editor. Every case passed: every file back on disk byte for byte, no dirty document, no error toast, Redo restored the edit exactly and a second Undo rewound it again. **The §5.8 fallback (`lastEditLayoutOnly`) is not needed and is not built.** Typing Cmd+Z on a focused canvas by hand stays a two-minute confirmation for the PR.

- 2026-10-28 (S5 review, round 1): fixes and the deviations they record.
  - **The GROUP and SELF universes are projected too** (§9.5): `relationshipStateSpace.dbml.test.ts` projects them (`projectGWorld`: diagram copies dropped, entries on their foreign-key table, a composite kept as its grouping) onto `tables/dim.dbml` + `tables/gold/fct.dbml` and `tables/gold/emp.dbml`, runs each distinct projected library once (the projection collapses most states) with every canvas edit `checkGroupState` / `checkSelfState` make, and checks one link per key, home-folder placement, Law 5, Law 4 on the table files and representability against `planRelationshipWrite` (`gWrite`); a refusal must leave the library unchanged. About 160 GROUP runs (composites written as `fct.(k, k_x)` Refs) and 50 SELF runs, 3 s, each with a floor. Every universe also re-sends each accepted edit and asserts no byte changes (Laws 1 and 2 at the canvas; Law 3 is the representability check).
  - **The §5.3 rows that had no case now have one**: Turn Round (a backwards many-to-one stored in `tables/_relationships.dbml` moves to `tables/gold/_relationships.dbml` the right way round, one edit), the `ready` position save (a partially positioned diagram writes only its `.dbdiagram`, the `.dbml` byte-identical) and removeModels of a folder's last member (its relationships file's `use` line goes). The addRelationship row asserts its exact path set.
  - **The ready load never fails on a DBML layout save.** `autoPositionNewTables` skips a DBML diagram that is not writable (a second Project, a repeated Note name) and treats an `EditRefused` / `DbmlEditRefused` / `DbdiagramLayoutRefused` (layout open with unsaved changes, layout not a JSON object) as "not saved": logged, and the canvas loads with the computed positions. A JSON diagram's ready save is unchanged.
  - **Relationships files are the ones on disk** (D1, §2.3): the planner names each folder's relationships file as the snapshot lists it (`_Relationships.dbml` in any case) and creates `_relationships.dbml` only for a folder that has none; new tables and moves use a folder's listed spelling. `relationshipsFileFor` and `planTableWrites`' folder do the same.
  - **The reserved name is refused by the planner** for a new table, a rename target and a move, with the §2.1 message (`RESERVED_TABLE_NAME_MESSAGE`, moved to `src/types/naming.ts`), so every caller is covered, the fs paths included. The handlers' own reserved checks for a typed name (Add Table, Rename) were removed: the authoring rule (a letter first) always refuses `_relationships` there first, so they could not run; the tests pin that rule's message. Add Existing and Add from dbt keep `validateNewDbmlTableName`.
  - **One D16 cascade, DBML owners only.** `TableLibraryService.dbmlDeleteCascadeOps(names)` builds the delete plus the other DBML owners' saves for both the canvas (`deleteTablesWithCascade`) and `deleteTable`, so a YAML owner's relationship to the deleted table stays in its yml (as deleting a YAML table leaves it) instead of failing the planner. The prompt counts only what the cascade removes. The cascade re-renders DBML diagrams only (`rewriteOtherSubjectAreaWrites(..., { dbmlOnly: true })`), so an open, dirty JSON diagram no longer refuses it, and a file it could not save is reported (`describeUnsaved`, with the save-failure telemetry codes).
  - **`deleteLogicalModel` for a `.dbml` table is brought forward from S6**: the Table Library's Delete Table runs the provider's D16 cascade (`deleteTablesWithCascade`, now public with `describeDbmlDeleteCascade`) with the confirm text "This removes the table's file, its N relationships and its place in M diagrams.", so no diagram is left importing a deleted file. The YAML path keeps its text until S6 makes it format-neutral.
  - **`newSubjectAreaWriter` snapshots every file a save writes** (§5.7): before each changed table is saved it asks `planTableWrites` which files that save writes (a DBML table's relationships files too) and records each one's bytes, or its absence; the rollback restores them or deletes the ones it created. The rest of §5.7's storage-aware writer stays S6.
  - **`usesLibraryRelationships` gets the DBML evidence from every caller** (`cli/diff.ts`, `importDbml.ts`, `drawFromDbt.ts` pass `hasDbmlLibrary()`), so a mixed project whose library holds DBML routes relationships and fixes to the library. Tested through Import DBML (`importDbml.test.ts`, one added case).
  - **`applyFileWrites`' reconcile deletes only what the edit created**: the prior state of a planned create is recorded too, so a create that failed because its file was already there (with the planned bytes) never deletes that file. When the reconcile could not put files back, the caller's "nothing was changed" label is not posted (the modal lists them); when the caller has no label, the plain "The edit could not be applied; nothing was changed." is posted.
  - **Other diagrams are read without their byte-order mark** (`openOrDiskText`), as the library snapshot already was, so a re-render never carries a second one into the document (VS Code keeps the BOM as the encoding).
  - **A routed relationship a DBML diagram cannot store is named**: when an add-tables edit routes a relationship whose many-side table's file cannot be read, the success note says "Not stored, because a table's file could not be read: …" instead of a console warning only.
- 2026-10-28 (S6 implementation): deviations and additions, each minimal.
  - **The switch-over lives in `TableLibraryService`.** `writesDbml()` (`writesDbml(projectStorage())`) decides every new table: `newTablePath` / `pathForNewTable` name `tables/[folder/]<name>.dbml` (a folder on disk in its listed spelling), `saveTable` of a new table and `planTableWrites`' default for a new table are DBML, and `newTableLibraryDirName()` is `tables`. A renamed YAML table still passes its own library and stays `.yml`; an existing table keeps its format.
  - **`newSubjectAreaWriter` keeps `documentText` for JSON and adds `document()`** (the diagram's v5 object) for DBML, instead of one `buildNewSubjectArea(storage)`: the writer picks by the diagram path's extension, which each caller chooses from `writesDbml()`. The DBML branch plans everything first (library plan, `renderNewSubjectAreaDbml`, the layout only when something is placed, and the settle pass through the new vscode-free `src/services/dbmlDiagramSettle.ts`), then applies it with `writeFilesWithRollback` (an injectable `io` for tests). A DBML diagram routes every relationship to the library (no diagram copies are honoured, D5); a routed one whose owner's file cannot be read is named in Draw from dbt's notice and in Import's "Left out" list (S6 review, below).
  - **Import DBML refuses, rather than skips**, a plan that would reuse a YAML library table or create a table named `_relationships` in a DBML project (`dbmlImportRefusal`, the D20 / §2.1 sentences): skipping a table inside `planDbmlImport` would also have to drop every Ref and position naming it. Draw from dbt skips both as specified (`DraftSkipReason` gains `yaml-table` and `reserved-name`, additive), each named in the notice.
  - **Give Duplicate Its Own Name for a `.dbml` copy** does not go through `planDbmlLibraryWrites`: the snapshot lists winners only, and its rename op re-spells every Ref naming the table, which would take the remaining copy's Refs with it. `planDbmlDuplicateRename` (`src/commands/dbmlLifecycle.ts`) splices the copy with `editTableDbml(copyText, …, {rename: true})` (alias set), deletes the old copy, and repoints only the DBML diagrams whose `use` line resolves to the copy's path (members and layout keys) through `editSubjectAreaDbml`; no Ref is touched. Same outcome as §5.7's row.
  - **Organise Table Library**: when any move is a `.dbml` table, the whole organise is one `applyFileWrites` edit, its YAML moves carried as file renames in that edit (S6 review, below); a YAML-only organise keeps its `renameFile` edit.
  - **Move Relationships to Table Library in a mixed project** stops with a named message when a target table is DBML ("… moves relationships into YAML table files only. Convert the project to DBML … to move them."), instead of writing DBML owners through `planDbmlLibraryWrites`; Convert (S7, §6.3) moves diagram-held relationships. In a DBML project it says "Nothing to move: …" as specified. Both commands are hidden by `erdStudio.storage != dbml` in the Table Library menu and the palette.
  - **Set Up keeps making the layer folders** (as today); it makes no `logical-models/` in a DBML project. New Diagram writes `layers.json` when it is missing in a DBML project (and with the folder, as before).
  - **The naming migration offer is skipped when storage ≠ `yaml`** (brought forward from §5.7's row; the "DBML offer eligible" half is S7).
  - **Export**: a Save As target (or an Export All folder) inside the semantic dir shows "Save the export outside .erd-studio/: files there are your diagrams' own storage." with Choose Another Location / Choose Another Folder, which reopens at the project root; nothing is written. The default-folder rule applies when `defaultSaveFolder` is unset (the extension already passes the workspace root).
  - **Sync plans**: `newTableFilePath` (semantic-dir relative, tolerant of an unsafe name) and `relationshipsFile` options; `TableContext.relationshipsPath` is additive.
  - **`commandErrors`**: `classifyWriteFailure` and `failedPath` look through a `cause` (a `FileWriteRollbackFailed`), so a DBML write that could not be put back still says what the disk refused. `isRefusedWrite` includes `DbmlEditRefused`, with `refusalLocation` for its Open File button.
  - **Tests changed for the switch-over** (each only seeds YAML evidence where its intent is the YAML/v6 path, or asserts DBML where its intent is a new project): `dbmlRoundTrip.test.ts` (a v6 JSON seed diagram for the v6 modes), `extension.activate.test.ts` (New Diagram, Open Example, Draw from dbt in a new project and the foreign-format toast now assert `.dbml`), `importDbml.test.ts` (`makeProject('v6')` seeds a v6 diagram; the no-ERD-folder cases assert DBML; the mixed case asserts a `.dbml` diagram; the failed-write case fails the write's own plan), `importDbml.activate.test.ts` and `openExampleDiagram.test.ts` (a new project writes DBML), `tableNaming.host.test.ts` ("no library folder" writes `tables/dim_first.dbml`), `libraryRelationships.test.ts`, `modelMeta.test.ts`, `moveRelationshipsToLibrary.test.ts` and `relationshipStateSpace.harness.ts` (an empty `logical-models/`, the YAML evidence `createTempWorkspace` uses). `logicalModelService.dbml.test.ts` is new on this branch (its S5 "until the switch-over" case now asserts the switch-over). The listed `drawFromDbt.writes`, `migrationService`, `dbmlImport`, `domainService`, `domainTreeProvider`, `gettingStartedPanel` and `semanticEditorProvider.integrity` tests needed no change; `logicalModelService.test.ts` needed none. The other existing tests `git diff --stat origin/develop -- test/unit` lists were changed (additively) by S1–S5 and are named in their entries above.
  - **New tests**: `test/unit/lifecycle.dbml.test.ts` (the switch-over, the DBML writer with its settle pass and a rollback after each write, Draw/Import refusals, the lifecycle planners, sync-plan paths, the Export refusal) and `test/unit/lifecycle.dbml.activate.test.ts` (the commands through `activate()`, plus automated stand-ins for §9.7 checks 5 and 7: New Diagram in an empty folder, a dropped single-file `.dbml` imported from its own URI). The dev-host runs of checks 5 and 7 are recorded below (S6 review).
- 2026-10-28 (S6 review, round 1): fixes and the deviations they record.
  - **The DBML New Subject Area write checks every file it plans for unsaved edits, settled diagrams included** (§5.7, §5.3 step 4). `writeNewSubjectArea` takes `readText` (open documents first, `openOrDiskText`, now shared from `src/providers/dirtyDocuments.ts`) and `dirtyFiles` hooks; after planning the library writes, the diagram, its layout and the settle pass, it refuses with `UnsavedFilesRefused` before the first write when any planned path is dirty. Draw from dbt, Import DBML and Open Example Diagram name the file ("… has unsaved changes. Save or revert it, then try again. Nothing was changed."), as Organise and Give Duplicate do.
  - **A relationship a DBML diagram cannot store is named, never dropped silently**: Draw from dbt's notice adds the S5 sentence ("Not stored, because a table's file could not be read: …", `describeUnstoredRelationships`, shared with the canvas), and Import DBML plans with `diagramHoldsNoRelationships`, so such a relationship is listed under "Left out" in the confirm ("not stored, because its table's file could not be read.") and not counted.
  - **Import's multi-file check finds `use` only at the top level**: `firstUseDeclarationLine` tracks bracket depth outside comments and strings, so a column or an enum value named `use` imports. The refusal text carries no Markdown (a notification shows it as plain text).
  - **Give Duplicate Its Own Name repoints a relationships file that imports the copy**: its `use` line for the name is re-resolved to the table the library uses by the planner's relationships-file writer (`editRelationshipsDbml` with `pathChanged`, `use` lines only, every Ref byte for byte), so the deleted copy is never left imported; the confirm lists the file with the diagrams it repoints.
  - **Organise in a mixed library moves YAML files byte for byte**: `applyFileWrites` gains `renames` (after the creates and replaces, before the deletes, moved back by the reconcile), so a YAML file in any encoding is renamed in the same edit, not re-encoded.
  - **"Nothing was changed" only when it is true**: `applyLifecycleWrites` returns `unrestored`, and Organise, Give Duplicate and the DBML Rename Subject Area post their failure label only when the reconcile put every file back (its modal names the rest).
  - **Rename Subject Area for a `.dbml` refuses a dirty `.dbdiagram` by name**; the diagram itself is read from disk after `handleUnsavedChanges` (saved, or the user chose Discard).
  - **Tests**: the S6 compile assertions run in 9.1.1, 10.3.1 and 11.0.0; new `test/unit/drawFromDbt.dbml.test.ts` (Draw end to end in a DBML project: `.dbml` diagram, Ref in the library, the settle of another diagram, the skip and not-stored sentences, a dirty settle target refused); a mixed Organise in one edit with a non-UTF-8 YAML file kept byte for byte; an `applyEdit` → false case for Organise, Give Duplicate and Rename (reconcile modal only); `recordDelete` of the layout file on Delete Subject Area; `applyFileWrites` rename order and reconcile.
- 2026-10-28 (S6, manual checks 5 and 7 recorded): run in a real VS Code 1.139.1 dev host, as S5's check 2 was. A throwaway harness (not committed) launched VS Code with `--extensionDevelopmentPath` (a copy of this build whose only changes expose each panel's webview message handler and answer the quick pick, input boxes and modals from the test runner) and `--extensionTestsPath`.
  - **Check 5** (a new, empty folder): New Diagram (layer Gold, name `orders`, description `Orders`) wrote exactly `.erd-studio/gold/orders.dbml` (a Project with its Note and `erd_schema_version: '7'`) and `.erd-studio/layers.json`. Opening it in the custom editor and adding the first table (`addModel` `dim_x`) created `tables/gold/dim_x.dbml`, added `use { table dim_x } from '../tables/gold/dim_x.dbml'` to the diagram and wrote its `.dbdiagram`; no error, no dirty document, and the project compiles clean.
  - **Check 7** (a dbdiagram.io single-file `gold/pulled.dbml` with its `.dbdiagram` dropped into a project): opening it posted `dbmlEmbeddedTables` after `domainLoaded` (the banner). The banner's Import (`importEmbeddedTables`) ran Import DBML on that file: the layer pick, the name `pulled-2`, then the confirm ("Import 2 tables into a new diagram "pulled-2" in the Gold layer."). It wrote `gold/pulled-2.dbml`, `gold/pulled-2.dbdiagram` (the source positions, 40/60 and 420/60), `tables/gold/customers.dbml`, `tables/gold/orders.dbml` and `tables/gold/_relationships.dbml`, left `pulled.dbml` as it was, opened the new diagram, and the project compiles clean. Seeing the banner's pixels by hand stays a one-minute confirmation for the PR.
