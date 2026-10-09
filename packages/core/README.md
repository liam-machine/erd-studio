# @erd-studio/core

The ERD Studio domain model, shared by the [ERD Studio](https://github.com/liam-machine/erd-studio) VS Code extension and `@erd-studio/renderer`.

It holds:

- the TypeScript types for the on-disk domain format (schema v5 plus `logical-models/*.yml` and `logical-models/{layer}/*.yml`), the layer configuration, the display-ready `DisplayDomain` the canvas renders, the cross-stage discrepancy report, and the edit messages the canvas posts to its host;
- the pure pipeline the extension host uses to turn those files into a `DisplayDomain`: `parseDomainJson`, `validateDomainDocument`, `buildUnifiedDomain`, `toLogicalStage`, `parseLogicalModelText`, `parseLayersText` / `validateLayersConfig`, `computeMissingPositions` and `toDisplayDomain`;
- `loadDisplayDomain`, which does all of that in one call over any async `readFile`;
- one-way exporters that turn a `DisplayDomain` into [Mermaid](https://mermaid.js.org) `erDiagram` or [DBML](https://dbml.dbdiagram.io) text: `toMermaid`, `toDbml`, `exportDiagram` and `diagramExportFileName`.

The package has no Node, `vscode`, React or React Flow dependency (its only dependency is `yaml`), so it runs in a browser, in Node and in bundlers alike.

The on-disk contract is documented in [`docs/semantic-domain-json-reference.md`](https://github.com/liam-machine/erd-studio/blob/main/docs/semantic-domain-json-reference.md).

```ts
import { detectDomainFormat, type DisplayDomain } from '@erd-studio/core';
```

## Loading a domain

```ts
import { loadDisplayDomain } from '@erd-studio/core';

const domain = await loadDisplayDomain({
  domainPath: '.erd-studio/silver/sales.json',   // {semanticDir}/{layer}/{domain}.json
  readFile: async (path) => fetchText(path),       // resolve null when the file does not exist
  readOnly: true,
});
```

`layers.json` and the `logical-models/` library are read from the same semantic directory as the domain file. A model file may sit at the top of the library or one folder down, in a folder named after a layer (`logical-models/gold/fct_order.yml`); names are unique across the library. Since `readFile` cannot list a directory, each model is found by probing `logical-models/{model}.yml`, then `logical-models/{layer}/{model}.yml` for every layer in `layers.json` (and the domain's own) in alphabetical order — the same order the extension uses — taking the first file that exists — a flat library costs one read per model, as before. A folder not named after a layer is only visible to hosts that can list directories (the extension). Each model file is read and parsed once, however often the domain lists it, with at most `maxParallelReads` (8) reads in flight. A model that is missing, unparseable or rejected renders as a placeholder, as it does in the extension.

Bad input rejects with one of four classes, so a host can map them to its own errors:

| Class | When |
|---|---|
| `DomainFileError` | the domain file is missing (`reason: 'missing'`), empty (`'empty'`) or not JSON (`'invalid-json'`), including a file holding unresolved git merge conflicts (`mergeConflict: true`, see below) |
| `DomainValidationError` | not a loadable domain: not an object, no or a newer `schemaVersion`, a legacy or hybrid layout, an unconfigured layer, a malformed v4 inline model (say, `columns` that is not a list) |
| `TooManyModelsError` | `logical.models` has more than `maxModels` entries (checked before any model file is read) |
| `FileTooLargeError` | the domain file is longer than `maxDomainChars` |

A `DomainFileError` carries `transient`: true for an empty or unparseable file, which may be a write still in progress and is worth reading again shortly. The exception is a domain file that still holds git's conflict markers (a `<<<<<<<` line, then `=======`, then `>>>>>>>`; a diff3 `|||||||` section is fine) and so does not parse: it is an `'invalid-json'` with `mergeConflict: true` and `line`, the 1-based line of the first `<<<<<<<`, and it is **not** transient — reading it again cannot help until someone resolves the conflict and saves the file. A file that parses is never reported as a conflict, whatever its text contains, and an older core reports the same file as plain invalid JSON. A model file with conflict markers renders as a placeholder whose `loadError` is `{ kind: 'yamlOther', line, mergeConflict: true }`, `line` again being the first `<<<<<<<`.

A `readFile` rejection is passed through unchanged. For files you do not control, the options also take:

- `modelNameFilter` (default `isSafeModelName`: no path separators, `..` or control characters); a rejected name is never read.
- `maxDomainChars`, which also applies to `layers.json`: a longer `layers.json` is not parsed, and the default layers are used instead.
- `maxYamlChars` and `maxYamlNodes`. A model file renders as a placeholder when it is longer than `maxYamlChars`, when its scalar text (counting every repeat through an alias) adds up to more than `maxYamlChars`, or when it expands to more than `maxYamlNodes` nodes. Between them they stop anchor/alias expansion bombs, whether they repeat many nodes or one long string (the entries of a `!!pairs` or `!!omap` sequence count as the nodes under them and the text they are read back as). A model the domain lists more than once is charged to both budgets once per listing, as an alias's repeats are; the listings past the budget render as placeholders, so repeating a name cannot make the result larger than the budgets allow one file.
- `ignoreStrayPositions`, which places models that have no position using only the positions of the domain's own models. The extension's placement checks every `viewConfig.positions` entry for every grid cell it tries, so a file listing many entries that name no model makes it slow; with this set, its cost depends only on the model count. The entries are still kept in the result. It defaults to on when any of `maxModels`, `maxYamlNodes`, `maxDomainChars` or `maxYamlChars` is finite, and to off otherwise; pass `false` to place models exactly as the extension does.

Every limit is off by default. The four-class contract above holds for input within the limits: with them all off, input large enough to exhaust the JavaScript engine (for example a domain listing on the order of 100,000 positions) can fail with the engine's own `RangeError` in the extension's placement code. Set every limit for files you do not control. A numeric limit must be a number of at least 0, or `Infinity` for none (`maxParallelReads`: a whole number of at least 1); anything else, `NaN` included, rejects with a `TypeError` before any file is read.

Each occurrence of a model is its own object, but occurrences share the parsed strings. The result keeps `undefined` values; serialise it (for example `JSON.parse(JSON.stringify(domain))`) if you need them dropped. Serialising writes out every occurrence's text, so the serialised size grows with the number of times the domain lists a model (within `maxYamlNodes` and `maxYamlChars` when they are set).

## Exporting a diagram

`toMermaid` and `toDbml` turn a `DisplayDomain` into text that other tools read: Mermaid `erDiagram` (which GitHub, GitLab and many wikis draw) and DBML (dbdiagram.io and other DBML tools). `exportDiagram` picks one by name, and `diagramExportFileName` suggests a safe file name.

```ts
import {
  loadDisplayDomain,
  exportDiagram,
  diagramExportFileName,
  DIAGRAM_EXPORT_FORMATS,          // ['mermaid', 'dbml']
  DIAGRAM_EXPORT_FILE_EXTENSIONS,  // { mermaid: 'mmd', dbml: 'dbml' }
  type DiagramExportFormat,
} from '@erd-studio/core';

const domain = await loadDisplayDomain({ domainPath, readFile, readOnly: true });
const format: DiagramExportFormat = 'dbml';
const text = exportDiagram(domain, format);          // or toDbml(domain) / toMermaid(domain)
const fileName = diagramExportFileName(domain, format); // e.g. 'sales.dbml'
```

- **One way.** ERD Studio's own files stay the only storage; nothing reads an export back in.
- **Pass the logical stage.** The functions accept any `DisplayDomain`, but ERD Studio's hosts export the logical (design) stage, which `loadDisplayDomain` returns.
- **A stable contract.** The same domain always gives the same text. Each export carries a versioned header (`// erd-studio dbml-export v1` as DBML's first line; `%% erd-studio mermaid-export v1` right after Mermaid's `erDiagram` line) and comment lines naming what it leaves out. Diagram positions are never exported.
- **ERD Studio's modelling fields go along.** In DBML they are readable lines in the notes: a table's `Note` holds `Role: …`, `Grain: …`, `Warehouse table (alias): …`, the description, the rationale (`Purpose: …`) and `Meta – key: value` lines; a column's note holds its description followed by `(natural key; SCD type 2; semi-additive; foreign key; meta key: value)`; a relationship role is the Ref's name. In Mermaid they are key markers (`PK`, `FK`, `UK`), attribute comments and `%%` lines. A model's `alias` is never DBML's `Table x as y`, whose names must be unique.
- **Opens in old and new tools.** The DBML uses no custom properties (they need `@dbml/parse` 9.1 or later, and every older DBML parser rejects the whole file) and no standalone `Note` blocks; the tests read every export with `@dbml/parse` 10.2.0 and the `@dbml/core` 3.13.4, 2.6.1 and 2.4.2 parsers many DBML tools still embed, and require all four to read the same thing. `@dbml/core` 2.4.2 (June 2022) is the oldest DBML parser the export supports: older releases reject schema-qualified table names or many-to-many `<>` Refs. The old and new parsers disagree about a backslash before another backslash or before `'` in a note, so such a backslash is followed by a space, with a comment saying so. Every Mermaid export parses in Mermaid 10.0.0, the oldest 10.x, and in 12.0.0.
- **Tolerant input.** Any optional field may be missing, as in a domain built by an older core. What a format cannot hold becomes a comment saying why, never an exception: a relationship to a model or column that is not in the domain, or a link already exported the other way round, in both formats; a model with no columns or a `loadError` in DBML, which has no table without columns (Mermaid draws it as an empty entity with a comment). `exportDiagram` throws only for an unknown format.
- **No new dependency.** The exporters are plain functions; the parsers the tests check them with are dev dependencies only.

## Development

This package lives in the `packages/core` workspace of the ERD Studio repository. Inside the repository it is consumed from source (TypeScript `paths` and vitest aliases); the published package ships only `dist/`.

```sh
npm run build -w @erd-studio/core       # dist/index.js (esbuild, ESM) + dist/*.d.ts (tsc)
npm run typecheck -w @erd-studio/core
npm test -w @erd-studio/core
```

## License

[PolyForm Shield 1.0.0](./LICENSE), the same licence as the rest of the repository.
