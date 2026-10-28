# @erd-studio/core

The ERD Studio domain model, shared by the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension and `@erd-studio/renderer`.

It holds:

- the TypeScript types for the on-disk format (ERD Studio 2.0's native DBML storage, `.dbml` files read through the `@erd-studio/core/dbml` subpath, and the older YAML/JSON projects: schema v5 plus `logical-models/*.yml` and `logical-models/{layer}/*.yml`, and schema v6's `tables/` naming, all read into the same in-memory shape), the layer configuration, the display-ready `DisplaySubjectArea` the canvas renders, the cross-stage discrepancy report, and the edit messages the canvas posts to its host;
- the pure pipeline the extension host uses to turn those files into a `DisplaySubjectArea`: `parseSubjectAreaJson`, `validateSubjectAreaDocument`, `buildUnifiedSubjectArea`, `toLogicalStage`, `parseTableText`, `parseLayersText` / `validateLayersConfig`, `computeMissingPositions` and `toDisplaySubjectArea`;
- `loadDisplaySubjectArea`, which does all of that in one call over any async `readFile` (for a DBML project, with the subpath's `dbmlStorageReader`);
- the parser-free half of DBML storage: `detectProjectStorage`, `classifySemanticFile` and the path helpers, `editDiagramLayout` for `.dbdiagram` layout files, and `normaliseForStorageEquivalence`;
- exporters that turn a `DisplaySubjectArea` into [Mermaid](https://mermaid.js.org) `erDiagram` or [DBML](https://dbml.dbdiagram.io) text: `toMermaid`, `toDbml`, `toDbmlRich` (ERD Studio's fields as DBML custom properties) with its dbdiagram layout file (`toDbdiagramLayout`, `serializeDbdiagramLayout`, `readDbdiagramLayout`), `exportDiagram` and `diagramExportFileName`.

The package has no Node, `vscode`, React or React Flow dependency (its dependencies are `yaml` and, for the `@erd-studio/core/dbml` subpath only, `@dbml/parse`), so it runs in a browser, in Node and in bundlers alike.

The on-disk contract (DBML projects first, then the YAML/JSON projects from before 2.0) is documented in the [file format reference](https://github.com/liam-machine/erd-studio/blob/main/docs/semantic-domain-json-reference.md).

```ts
import { detectSubjectAreaFormat, type DisplaySubjectArea } from '@erd-studio/core';
```

## Loading a domain

```ts
import { loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';

const domain = await loadDisplaySubjectArea({
  domainPath: '.erd-studio/gold/sales.dbml',     // {semanticDir}/{layer}/{diagram}.dbml (or .json)
  readFile: async (path) => fetchText(path),       // resolve null when the file does not exist
  readOnly: true,
  dbml: dbmlStorageReader,                         // needed for .dbml files; omit it to stay parser-free
});
```

A project from before ERD Studio 2.0 has `.json` diagrams and `.yml` tables; pass its `{layer}/{diagram}.json` the same way (with or without `dbml`). The rest of this section describes the YAML/JSON lookup; the DBML one is under [Native DBML storage](#native-dbml-storage-the-erd-studiocoredbml-subpath).

`layers.json` and the `logical-models/` library are read from the same semantic directory as the domain file. A model file may sit at the top of the library or one folder down, in a folder named after a layer (`logical-models/gold/fct_order.yml`); names are unique across the library. Since `readFile` cannot list a directory, each model is found by probing `logical-models/{model}.yml`, then `logical-models/{layer}/{model}.yml` for every layer in `layers.json` (and the domain's own) in alphabetical order — the same order the extension uses — then the same under v6's `tables/`, taking the first file that exists — a flat v5 library costs one read per model, as before. A folder not named after a layer is only visible to hosts that can list directories (the extension). Each model file is read and parsed once, however often the domain lists it, with at most `maxParallelReads` (8) reads in flight. A model that is missing, unparseable or rejected renders as a placeholder, as it does in the extension.

Bad input rejects with one of four classes, so a host can map them to its own errors:

| Class | When |
|---|---|
| `SubjectAreaFileError` | the domain file is missing (`reason: 'missing'`), empty (`'empty'`), not JSON (`'invalid-json'`) or, for a `.dbml` diagram read with `dbml` (see below), not valid DBML (`'invalid-dbml'`), including a file holding unresolved git merge conflicts (`mergeConflict: true`, see below) |
| `SubjectAreaValidationError` | not a loadable domain: not an object, no or a newer `schemaVersion`, a legacy or hybrid layout, an unconfigured layer, a malformed v4 inline model (say, `columns` that is not a list) |
| `TooManyTablesError` | `logical.models` has more than `maxModels` entries (checked before any model file is read) |
| `FileTooLargeError` | the domain file is longer than `maxDomainChars` |

A `SubjectAreaFileError` carries `transient`: true for an empty or unparseable file, which may be a write still in progress and is worth reading again shortly. The exception is a domain file that still holds git's conflict markers (a `<<<<<<<` line, then `=======`, then `>>>>>>>`; a diff3 `|||||||` section is fine) and so does not parse: it is an `'invalid-json'` with `mergeConflict: true` and `line`, the 1-based line of the first `<<<<<<<`, and it is **not** transient — reading it again cannot help until someone resolves the conflict and saves the file. Any other `'invalid-json'` carries `line` and `column` (1-based) and `syntaxProblem` (`'trailing-comma'`, `'missing-comma'`, `'truncated'` or `'unexpected'`) when the mistake can be located, pointing at where the fix goes; an older core leaves them unset. A file that parses is never reported as a conflict, whatever its text contains, and an older core reports the same file as plain invalid JSON. A model file with conflict markers renders as a placeholder whose `loadError` is `{ kind: 'yamlOther', line, mergeConflict: true }`, `line` again being the first `<<<<<<<`. A model file whose only YAML errors are keys written twice is **not** a placeholder: it renders with the last copy of each key, as dbt's PyYAML reads it, and the model carries an optional `loadWarning: { kind: 'yamlDuplicateKey', key, line }` (`line` being the copy that is used). An older core rendered it as a placeholder with a `yamlDuplicateKey` `loadError`. `parseTableText` keeps throwing on a duplicate key unless you pass `{ duplicateKeys: 'last' }`.

A `readFile` rejection is passed through unchanged. For files you do not control, the options also take:

- `modelNameFilter` (default `isSafeTableName`: no path separators, `..` or control characters); a rejected name is never read.
- `maxDomainChars`, which also applies to `layers.json`: a longer `layers.json` is not parsed, and the default layers are used instead.
- `maxYamlChars` and `maxYamlNodes`. A model file renders as a placeholder when it is longer than `maxYamlChars`, when its scalar text (counting every repeat through an alias) adds up to more than `maxYamlChars`, or when it expands to more than `maxYamlNodes` nodes. Between them they stop anchor/alias expansion bombs, whether they repeat many nodes or one long string (the entries of a `!!pairs` or `!!omap` sequence count as the nodes under them and the text they are read back as). A model the domain lists more than once is charged to both budgets once per listing, as an alias's repeats are; the listings past the budget render as placeholders, so repeating a name cannot make the result larger than the budgets allow one file.
- `ignoreStrayPositions`, which places models that have no position using only the positions of the domain's own models. The extension's placement checks every `viewConfig.positions` entry for every grid cell it tries, so a file listing many entries that name no model makes it slow; with this set, its cost depends only on the model count. The entries are still kept in the result. It defaults to on when any of `maxModels`, `maxYamlNodes`, `maxDomainChars` or `maxYamlChars` is finite, and to off otherwise; pass `false` to place models exactly as the extension does.

Every limit is off by default. The four-class contract above holds for input within the limits: with them all off, input large enough to exhaust the JavaScript engine (for example a domain listing on the order of 100,000 positions) can fail with the engine's own `RangeError` in the extension's placement code. Set every limit for files you do not control. A numeric limit must be a number of at least 0, or `Infinity` for none (`maxParallelReads`: a whole number of at least 1); anything else, `NaN` included, rejects with a `TypeError` before any file is read.

Each occurrence of a model is its own object, but occurrences share the parsed strings. The result keeps `undefined` values; serialise it (for example `JSON.parse(JSON.stringify(domain))`) if you need them dropped. Serialising writes out every occurrence's text, so the serialised size grows with the number of times the domain lists a model (within `maxYamlNodes` and `maxYamlChars` when they are set).

### Native DBML storage: the `@erd-studio/core/dbml` subpath

A project can store its tables, relationships and diagrams as DBML, an open format (`tables/[<folder>/]<name>.dbml`, `tables/[<folder>/]_relationships.dbml`, `<layer>/<name>.dbml` with its layout in `<layer>/<name>.dbdiagram`). The readers need `@dbml/parse`, so they live behind a subpath and the main entry stays parser-free (a webview or renderer bundle never pays for the parser):

```ts
import { loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';

const domain = await loadDisplaySubjectArea({
  domainPath: '.erd-studio/gold/sales.dbml',
  readFile: async (path) => fetchText(path),
  readOnly: true,
  dbml: dbmlStorageReader,
});
```

Without `dbml`, a `.dbml` diagram rejects with a `SubjectAreaValidationError` saying to pass it, and a DBML table or relationships file passed as `domainPath` is refused as not a diagram. With it, a JSON diagram also finds tables stored as `.dbml` and draws their relationships. A DBML diagram that does not parse is a `SubjectAreaFileError` with `reason: 'invalid-dbml'` (transient, with `line` and `column`; with `mergeConflict: true` and not transient for git conflict markers). `maxYamlChars` limits a `.dbml` table file as written (`maxYamlNodes` does not apply to DBML), and `maxRelationshipsChars` limits each relationships file: a longer one is not read, and its relationships are not drawn. The subpath also exports the readers on their own (`parseTableDbml`, `readRelationshipsDbml`, `parseSubjectAreaDbml`, `subjectAreaMembersDbml`), `compileDbmlProject` (a multi-file compile, as other DBML tools read the project) and `DbmlEditRefused`; every export is typed with this package's own types.

## Exporting a diagram

`toMermaid`, `toDbml` and `toDbmlRich` turn a `DisplaySubjectArea` into text that other tools read: Mermaid `erDiagram` (which GitHub, GitLab and many wikis draw), portable DBML (every DBML tool) and rich DBML (dbdiagram.io, dbdocs and DBML 9.1+ tools, and ERD Studio's own DBML import). `exportDiagram` picks one by name, and `diagramExportFileName` suggests a safe file name.

```ts
import {
  loadDisplaySubjectArea,
  exportDiagram,
  diagramExportFileName,
  DIAGRAM_EXPORT_FORMATS,          // ['mermaid', 'dbml', 'dbml-rich']
  DIAGRAM_EXPORT_FILE_EXTENSIONS,  // { mermaid: 'mmd', dbml: 'dbml', 'dbml-rich': 'dbml' }
  type DiagramExportFormat,
} from '@erd-studio/core';

const domain = await loadDisplaySubjectArea({ domainPath, readFile, readOnly: true });
const format: DiagramExportFormat = 'dbml';
const text = exportDiagram(domain, format);          // or toDbml(domain) / toMermaid(domain)
const fileName = diagramExportFileName(domain, format); // e.g. 'sales.dbml'
```

- **Exports are not storage.** A project's own files (`.dbml` in ERD Studio 2.0, YAML/JSON before) are its storage; an export is a single self-contained file for another tool. Mermaid and portable DBML are one way; rich DBML is the format ERD Studio's DBML import reads back (below).
- **Pass the logical stage.** The functions accept any `DisplaySubjectArea`, but ERD Studio's hosts export the logical (design) stage, which `loadDisplaySubjectArea` returns.
- **A stable contract.** The same domain always gives the same text. Each export carries a versioned header (`// erd-studio dbml-export v1` as DBML's first line; `%% erd-studio mermaid-export v1` right after Mermaid's `erDiagram` line) and comment lines naming what it leaves out. Diagram positions are never exported.
- **ERD Studio's modelling fields go along.** In DBML they are readable lines in the notes: a table's `Note` holds `Role: …`, `Grain: …`, `Warehouse table (alias): …`, the description, the rationale (`Purpose: …`) and `Meta – key: value` lines; a column's note holds its description followed by `(natural key; SCD type 2; semi-additive; foreign key; meta key: value)`; a relationship role is the Ref's name. In Mermaid they are key markers (`PK`, `FK`, `UK`), attribute comments and `%%` lines. A model's `alias` is never DBML's `Table x as y`, whose names must be unique.
- **Opens in old and new tools.** The DBML uses no custom properties (they need `@dbml/parse` 9.1 or later, and every older DBML parser rejects the whole file) and no standalone `Note` blocks; the tests read every export with the pinned `@dbml/parse` (11.0.0) and the `@dbml/core` 3.13.4, 2.6.1 and 2.4.2 parsers many DBML tools still embed, and require all four to read the same thing. `@dbml/core` 2.4.2 (June 2022) is the oldest DBML parser the export supports: older releases reject schema-qualified table names or many-to-many `<>` Refs. The old and new parsers disagree about a backslash before another backslash or before `'` in a note, so such a backslash is followed by a space, with a comment saying so. Every Mermaid export parses in Mermaid 10.0.0, the oldest 10.x, and in 12.0.0.
- **Tolerant input.** Any optional field may be missing, as in a domain built by an older core. What a format cannot hold becomes a comment saying why, never an exception: a relationship to a model or column that is not in the domain, or a link already exported the other way round, in both formats; a model with no columns or a `loadError` in DBML, which has no table without columns (Mermaid draws it as an empty entity with a comment). `exportDiagram` throws only for an unknown format.
- **No parser at run time.** The exporters are plain functions in the main entry and never load `@dbml/parse` (only the `@erd-studio/core/dbml` subpath does); the older parsers the tests check them with are dev dependencies only.

### Rich DBML and the dbdiagram layout

`toDbmlRich(domain)` (format `'dbml-rich'`) writes the same tables and relationships as `toDbml`, with ERD Studio's fields as DBML custom properties instead of note lines, so dbdiagram.io and dbdocs show them as real fields and ERD Studio's import reads them back. Its positions go in a second file, dbdiagram's own `<name>.dbdiagram`, beside the `.dbml`; `dbdiagram push sales.dbml` then opens the diagram where it was on the canvas.

```ts
import { toDbmlRich, serializeDbdiagramLayout, dbdiagramLayoutFileName, diagramExportFileName } from '@erd-studio/core';

const files = {
  [diagramExportFileName(domain, 'dbml-rich')]: toDbmlRich(domain),   // 'sales.dbml'
  [dbdiagramLayoutFileName(domain)]: serializeDbdiagramLayout(domain), // 'sales.dbdiagram'
};
```

- **Needs a DBML 9.1+ parser.** Custom properties arrived in `@dbml/parse` 9.1; older parsers reject the file, which is why `toDbml` stays notes-only. The tests read every rich export with `@dbml/parse` 9.1.1, 10.3.1 and 11.0.0, which must agree, with no error or warning.
- **Properties.** Table: `role`, `grain`, `alias`, `schema: 'public'` (only for that schema: DBML reads `Table public.x` as a table with no schema), `rationale_<snake_case key>` (`rationale_scd_strategy`). Column: `natural_key: 'true'`, `scd_type: '2'`, `additive_type: 'semi-additive'`, `foreign_key: 'true'` (the model file's own flag, or a foreign-key badge no exported Ref explains). Meta: `meta_<key>` for a text value under a lower-case identifier key, and every other entry (a yes/no, null, list, map, or any other key) as JSON in one `meta_json`, so it round-trips exactly (the text entries come back first). Values are always quoted strings (typed values need DBML 11). The names are exported as constants (`DBML_RICH_TABLE_PROPERTIES`, `DBML_RICH_COLUMN_PROPERTIES`, …); an importer also accepts each with an `erd_` prefix.
- **Refs from the foreign key.** A many-to-one or one-to-many is written from its foreign-key end (`Ref: fct.customer_key >? dim.customer_key`), a one-to-one key end first (`Ref: dim.customer_key ?- profile.customer_key`, because DBML reads a one-to-one's second end as the foreign key) with the foreign-key column marked `unique`, a many-to-many as `<>`. ERD Studio does not record nullability, so a `?` marks every end that is not primary-key columns as possibly null (DBML 9+ reads a bare `>` as NOT NULL). A composite foreign key is one Ref.
- **Everything else.** The subject area is the `Project`, the layer a `TableGroup` of every table (with the layer colour), sticky notes `Note sticky_<n> [color: #hex, linked_table: '…']` blocks, and a table without columns gets a placeholder column marked `erd_placeholder`, which import drops. The header (`// erd-studio dbml-export v2 (DBML 9.1+)`) names the layout file; pass `{ layoutFileName }` when you save under another name.
- **The layout file.** `toDbdiagramLayout(domain)` is the `.dbdiagram` JSON (version `"3.0.0"`): `defaultView.tablePositions` names each table as the DBML does (`schemaName: "public"` for one without a schema), in canvas pixels. Sticky-note positions are not written. `readDbdiagramLayout(text)` is the tolerant reader an import uses: it never throws, and lists what it could not read in `problems`.

## Development

This package lives in the `packages/core` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/core       # dist/index.js (esbuild, ESM) + dist/*.d.ts (tsc)
npm run typecheck -w @erd-studio/core
npm test -w @erd-studio/core
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
